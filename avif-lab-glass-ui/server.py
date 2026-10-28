"""AVIF Lab API: authenticated web app + robot camera WebSocket.

Passwords are salted and hashed with scrypt. The server never stores plaintext passwords.
This is a local-network starter; use HTTPS/WSS and a long device token outside a trusted LAN.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
DB_PATH = Path(os.environ.get("AVIF_DB_PATH", str(DATA_DIR / "avif_lab.sqlite3")))
ROBOT_DEVICE_TOKEN = os.environ.get("ROBOT_DEVICE_TOKEN", "").strip()
COOKIE_SECURE = os.environ.get("AVIF_COOKIE_SECURE", "0").strip() == "1"
COOKIE_NAME = "avif_session"
SESSION_TTL = 7 * 24 * 60 * 60
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_JPEG_BYTES = 1_500_000
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,40}$")
ALLOWED_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv", ".avi", ".avif", ".avifs", ".jpg", ".jpeg", ".png", ".webp"}

app = FastAPI(title="AVIF Lab API", version="0.4.0", docs_url="/api/docs", redoc_url=None)
robot_clients: set[WebSocket] = set()
camera_viewers: set[WebSocket] = set()
latest_frame: bytes | None = None
latest_frame_at: float | None = None
frames_received = 0
robot_telemetry: dict = {}
state_lock = asyncio.Lock()


def db_connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def init_db() -> None:
    with closing(db_connect()) as db:
        db.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS users (
                username TEXT PRIMARY KEY COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
            CREATE TABLE IF NOT EXISTS video_files (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL COLLATE NOCASE REFERENCES users(username) ON DELETE CASCADE,
                original_name TEXT NOT NULL,
                stored_name TEXT NOT NULL,
                content_type TEXT,
                size_bytes INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            """
        )
        db.commit()


def password_hash(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    # scrypt is deliberately slow and memory-hard. These parameters suit a small local app.
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**15, r=8, p=1, dklen=64, maxmem=64 * 1024 * 1024)
    return f"scrypt$32768$8$1${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_hex, digest_hex = encoded.split("$")
        if algorithm != "scrypt":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(n), r=int(r), p=int(p), dklen=len(expected), maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def current_username_from_token(token: str | None) -> str | None:
    if not token:
        return None
    now = int(time.time())
    with closing(db_connect()) as db:
        row = db.execute(
            "SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?",
            (token_digest(token), now),
        ).fetchone()
        db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
        db.commit()
    return str(row["username"]) if row else None


def require_user(request: Request) -> str:
    username = current_username_from_token(request.cookies.get(COOKIE_NAME))
    if not username:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    return username


def create_session(username: str, response: JSONResponse) -> None:
    raw_token = secrets.token_urlsafe(32)
    expires_at = int(time.time()) + SESSION_TTL
    with closing(db_connect()) as db:
        db.execute("INSERT INTO sessions(token_hash, username, expires_at) VALUES (?, ?, ?)", (token_digest(raw_token), username, expires_at))
        db.commit()
    response.set_cookie(
        COOKIE_NAME,
        raw_token,
        max_age=SESSION_TTL,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="strict",
        path="/",
    )


class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=10, max_length=128)


class LoginBody(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=1, max_length=128)


class RobotCommandBody(BaseModel):
    command: Literal["forward", "reverse", "left", "right", "stop"]


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not ROBOT_DEVICE_TOKEN:
        print("[AVIF Lab] ROBOT_DEVICE_TOKEN is not set; robot device connections will be rejected until configured.")
    print(f"[AVIF Lab] Database: {DB_PATH}")
    if not COOKIE_SECURE:
        print("[AVIF Lab] Local-development cookie mode. Use HTTPS and AVIF_COOKIE_SECURE=1 outside a trusted LAN.")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "version": app.version, "robot_configured": bool(ROBOT_DEVICE_TOKEN)}


@app.post("/api/auth/register", status_code=201)
def register(body: RegisterBody) -> JSONResponse:
    username = body.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise HTTPException(status_code=400, detail="Use 3–40 letters, numbers, dots, dashes, or underscores for the username.")
    if len(body.password.strip()) < 10:
        raise HTTPException(status_code=400, detail="Use a password with at least 10 non-space characters.")
    if body.password.isspace():
        raise HTTPException(status_code=400, detail="Password cannot contain only spaces.")
    try:
        with closing(db_connect()) as db:
            db.execute("INSERT INTO users(username, password_hash, created_at) VALUES (?, ?, ?)", (username, password_hash(body.password), int(time.time())))
            db.commit()
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="That username is already registered.")
    response = JSONResponse({"username": username, "message": "Account created."}, status_code=201)
    create_session(username, response)
    return response


@app.post("/api/auth/login")
def login(body: LoginBody) -> JSONResponse:
    with closing(db_connect()) as db:
        row = db.execute("SELECT username, password_hash FROM users WHERE username = ? COLLATE NOCASE", (body.username.strip(),)).fetchone()
    # Run a dummy scrypt check for unknown usernames, reducing timing differences.
    if not row:
        password_hash("invalid-login-dummy-password")
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    if not verify_password(body.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid username or password.")
    username = str(row["username"])
    response = JSONResponse({"username": username, "message": "Signed in."})
    create_session(username, response)
    return response


@app.post("/api/auth/logout")
def logout(request: Request) -> JSONResponse:
    token = request.cookies.get(COOKIE_NAME)
    if token:
        with closing(db_connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_digest(token),))
            db.commit()
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=COOKIE_SECURE, samesite="strict")
    return response


@app.get("/api/auth/me")
def auth_me(request: Request) -> dict:
    username = require_user(request)
    return {"username": username}


@app.get("/api/robot/status")
async def robot_status(request: Request) -> dict:
    require_user(request)
    async with state_lock:
        connected = bool(robot_clients)
        frame_at = latest_frame_at
        frame_count = frames_received
        telemetry = dict(robot_telemetry)
    return {
        "connected": connected,
        "camera_ready": frame_at is not None and time.time() - frame_at < 5,
        "last_frame_at": frame_at,
        "frames_received": frame_count,
        "telemetry": telemetry,
    }


@app.post("/api/robot/command")
async def robot_command(body: RobotCommandBody, request: Request) -> dict:
    require_user(request)
    async with state_lock:
        clients = list(robot_clients)
    if not clients:
        raise HTTPException(status_code=503, detail="Robot is offline. Connect the robot to the API first.")
    command = body.command
    # Commands are deliberately constrained and short. Hardware firmware must enforce its own watchdog.
    payload = {"type": "command", "command": command, "speed": 0.22 if command != "stop" else 0, "duration_ms": 300 if command != "stop" else 0}
    sent = 0
    for client in clients:
        try:
            await client.send_text(json.dumps(payload))
            sent += 1
        except Exception:
            async with state_lock:
                robot_clients.discard(client)
    if not sent:
        raise HTTPException(status_code=503, detail="Robot connection was lost before the command could be sent.")
    return {"sent": True, **payload}


@app.post("/api/video/upload", status_code=201)
async def video_upload(request: Request, file: UploadFile = File(...)) -> dict:
    username = require_user(request)
    original_name = re.split(r"[\\/]", file.filename or "upload.bin")[-1][:200]
    suffix = Path(original_name).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(status_code=415, detail="Supported files: common video formats, AVIF, JPEG, PNG, and WebP.")
    file_id = uuid.uuid4().hex
    stored_name = f"{file_id}{suffix}"
    target = UPLOAD_DIR / stored_name
    total = 0
    try:
        with target.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(status_code=413, detail="Upload exceeds the 200 MB prototype limit.")
                output.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="The uploaded file is empty.")
        with closing(db_connect()) as db:
            db.execute(
                "INSERT INTO video_files(id, username, original_name, stored_name, content_type, size_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (file_id, username, original_name, stored_name, file.content_type, total, int(time.time())),
            )
            db.commit()
    except Exception:
        target.unlink(missing_ok=True)
        raise
    finally:
        await file.close()
    return {"id": file_id, "filename": original_name, "content_type": file.content_type, "size_bytes": total, "url": f"/api/video/{file_id}"}


@app.get("/api/video/{file_id}")
def video_get(file_id: str, request: Request) -> FileResponse:
    username = require_user(request)
    with closing(db_connect()) as db:
        row = db.execute("SELECT * FROM video_files WHERE id = ? AND username = ?", (file_id, username)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="File not found.")
    path = UPLOAD_DIR / row["stored_name"]
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Stored file is missing.")
    return FileResponse(path, media_type=row["content_type"] or "application/octet-stream", filename=row["original_name"])


async def broadcast_status() -> None:
    status = {"type": "robot_status", "connected": bool(robot_clients), "camera_ready": latest_frame_at is not None and time.time() - latest_frame_at < 5}
    dead: list[WebSocket] = []
    for viewer in list(camera_viewers):
        try:
            await viewer.send_json(status)
        except Exception:
            dead.append(viewer)
    for viewer in dead:
        camera_viewers.discard(viewer)


async def broadcast_frame(frame: bytes) -> None:
    dead: list[WebSocket] = []
    # Keep the prototype simple. If a viewer is slow, drop it instead of stalling the robot sender.
    for viewer in list(camera_viewers):
        try:
            await asyncio.wait_for(viewer.send_bytes(frame), timeout=0.35)
        except Exception:
            dead.append(viewer)
    for viewer in dead:
        camera_viewers.discard(viewer)


@app.websocket("/ws/robot/camera")
async def robot_camera_socket(websocket: WebSocket) -> None:
    global latest_frame, latest_frame_at, frames_received, robot_telemetry
    await websocket.accept()
    if not ROBOT_DEVICE_TOKEN:
        await websocket.send_json({"type": "error", "message": "Server has no ROBOT_DEVICE_TOKEN configured."})
        await websocket.close(code=1013)
        return
    registered = False
    try:
        raw_auth = await asyncio.wait_for(websocket.receive_text(), timeout=8)
        auth = json.loads(raw_auth)
        supplied = str(auth.get("token", "")) if isinstance(auth, dict) else ""
        if not isinstance(auth, dict) or auth.get("type") != "auth" or not hmac.compare_digest(supplied, ROBOT_DEVICE_TOKEN):
            await websocket.send_json({"type": "error", "message": "Device authentication failed."})
            await websocket.close(code=1008)
            return
        async with state_lock:
            already_connected = bool(robot_clients)
            if not already_connected:
                robot_clients.add(websocket)
                registered = True
        if already_connected:
            await websocket.send_json({"type": "error", "message": "A robot device is already connected."})
            await websocket.close(code=1013)
            return
        await websocket.send_json({"type": "auth", "ok": True})
        await broadcast_status()
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            binary = message.get("bytes")
            if binary is not None:
                if len(binary) < 4 or len(binary) > MAX_JPEG_BYTES or not (binary.startswith(b"\xff\xd8") and binary.endswith(b"\xff\xd9")):
                    # Ignore invalid or oversized frames rather than passing them into the viewer pipeline.
                    continue
                async with state_lock:
                    latest_frame = binary
                    latest_frame_at = time.time()
                    frames_received += 1
                await broadcast_frame(binary)
                continue
            text_message = message.get("text")
            if text_message:
                try:
                    payload = json.loads(text_message)
                except json.JSONDecodeError:
                    continue
                if isinstance(payload, dict) and payload.get("type") == "telemetry":
                    data = payload.get("data", {})
                    if isinstance(data, dict):
                        clean = {}
                        for key in ("battery", "sensor_left", "sensor_right", "mode", "line_detected"):
                            value = data.get(key)
                            if isinstance(value, (int, float, str, bool)):
                                clean[key] = value
                        async with state_lock:
                            robot_telemetry = clean
                        for viewer in list(camera_viewers):
                            try:
                                await viewer.send_json({"type": "telemetry", "data": clean})
                            except Exception:
                                camera_viewers.discard(viewer)
    except (WebSocketDisconnect, asyncio.TimeoutError, json.JSONDecodeError):
        pass
    finally:
        if registered:
            async with state_lock:
                robot_clients.discard(websocket)
            await broadcast_status()


@app.websocket("/ws/camera")
async def camera_view_socket(websocket: WebSocket) -> None:
    token = websocket.cookies.get(COOKIE_NAME)
    username = current_username_from_token(token)
    await websocket.accept()
    if not username:
        await websocket.send_json({"type": "error", "message": "Sign in to view the robot camera."})
        await websocket.close(code=1008)
        return
    camera_viewers.add(websocket)
    try:
        await websocket.send_json({"type": "robot_status", "connected": bool(robot_clients), "camera_ready": latest_frame_at is not None and time.time() - latest_frame_at < 5})
        if latest_frame is not None:
            await websocket.send_bytes(latest_frame)
        while True:
            # Text pings from the browser keep older proxy setups from idling out.
            await websocket.receive_text()
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        camera_viewers.discard(websocket)


# Serve only public front-end files. Do not mount the project root as a static
# directory: that would make server.py, the SQLite database, and uploaded media
# potentially retrievable by path, bypassing API authorization.
@app.get("/", include_in_schema=False)
def frontend_index() -> FileResponse:
    return FileResponse(ROOT / "index.html", media_type="text/html; charset=utf-8")


@app.get("/styles.css", include_in_schema=False)
def frontend_styles() -> FileResponse:
    return FileResponse(ROOT / "styles.css", media_type="text/css; charset=utf-8")


@app.get("/app.js", include_in_schema=False)
def frontend_script() -> FileResponse:
    return FileResponse(ROOT / "app.js", media_type="text/javascript; charset=utf-8")
