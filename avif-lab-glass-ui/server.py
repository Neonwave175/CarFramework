"""AVIF Lab API: authenticated web app + robot camera WebSocket.

Passwords are salted and hashed with scrypt. The server never stores plaintext passwords.
This is a local-network starter; use HTTPS/WSS and a long device token outside a trusted LAN.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import time
import uuid
from collections import deque
from contextlib import closing
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
# Electron stores mutable data under the OS user-data directory. The web app
# keeps its original project-local defaults when these variables are absent.
DATA_DIR = Path(os.environ.get("AVIF_DATA_DIR", str(ROOT / "data")))
UPLOAD_DIR = Path(os.environ.get("AVIF_UPLOAD_DIR", str(ROOT / "uploads")))
DB_PATH = Path(os.environ.get("AVIF_DB_PATH", str(DATA_DIR / "avif_lab.sqlite3")))
ROBOT_DEVICE_TOKEN = os.environ.get("ROBOT_DEVICE_TOKEN", "").strip()
CARFRAMEWORK_ROOT = Path(os.environ.get("CARFRAMEWORK_ROOT", str(ROOT.parent))).expanduser()
CARFRAMEWORK_METRICS_TOKEN = os.environ.get("CARFRAMEWORK_METRICS_TOKEN", "").strip()
CARFRAMEWORK_METRICS_BIND = os.environ.get("CARFRAMEWORK_METRICS_BIND", "0.0.0.0").strip() or "0.0.0.0"
try:
    CARFRAMEWORK_METRICS_PORT = int(os.environ.get("CARFRAMEWORK_METRICS_PORT", "5007"))
except ValueError:
    CARFRAMEWORK_METRICS_PORT = 5007
if not 1024 <= CARFRAMEWORK_METRICS_PORT <= 65535:
    CARFRAMEWORK_METRICS_PORT = 5007
COOKIE_SECURE = os.environ.get("AVIF_COOKIE_SECURE", "0").strip() == "1"
COOKIE_NAME = "avif_session"
SESSION_TTL = 7 * 24 * 60 * 60
MAX_UPLOAD_BYTES = 200 * 1024 * 1024
MAX_JPEG_BYTES = 1_500_000
USERNAME_RE = re.compile(r"^[a-zA-Z0-9_.-]{3,40}$")
ALLOWED_SUFFIXES = {".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv", ".avi", ".avif", ".avifs", ".jpg", ".jpeg", ".png", ".webp"}

app = FastAPI(title="Aurora Glass API", version="0.7.0", docs_url="/api/docs", redoc_url=None)
robot_clients: set[WebSocket] = set()
camera_viewers: set[WebSocket] = set()
latest_frame: bytes | None = None
latest_frame_at: float | None = None
frames_received = 0
robot_telemetry: dict = {}
robot_telemetry_at: float | None = None
state_lock = asyncio.Lock()
APP_STARTED_MONOTONIC = time.monotonic()
ws_frame_samples: deque[tuple[float, int]] = deque(maxlen=600)
carframework_metrics: dict = {}
carframework_metrics_received_at: float | None = None
metrics_udp_transport: asyncio.DatagramTransport | None = None
metrics_listener_active = False


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


class SignedMetricsProtocol(asyncio.DatagramProtocol):
    """Accept small HMAC-authenticated status packets from CarFramework reciever.py."""

    def datagram_received(self, packet: bytes, addr) -> None:
        global carframework_metrics, carframework_metrics_received_at
        if not CARFRAMEWORK_METRICS_TOKEN:
            return
        try:
            if len(packet) > 4096:
                return
            signature, payload = packet.split(b".", 1)
            expected = hmac.new(CARFRAMEWORK_METRICS_TOKEN.encode("utf-8"), payload, hashlib.sha256).hexdigest().encode("ascii")
            if not hmac.compare_digest(signature, expected):
                return
            data = json.loads(payload.decode("utf-8"))
            if not isinstance(data, dict) or data.get("type") != "carframework_metrics" or data.get("version") != 1:
                return
            raw_timestamp = data.get("timestamp")
            if isinstance(raw_timestamp, bool) or not isinstance(raw_timestamp, (int, float)):
                return
            timestamp = float(raw_timestamp)
            # Wall clocks may be unsynchronised on an internet-free car network.
            # Use the authenticated session ID + sequence for replay filtering;
            # receipt time on this host is used for freshness calculations.
            if not math.isfinite(timestamp) or timestamp <= 0:
                return
            session_id = str(data.get("session_id", ""))[:64]
            raw_sequence = data.get("sequence")
            if isinstance(raw_sequence, bool) or not isinstance(raw_sequence, int):
                return
            sequence = raw_sequence
            if not session_id or sequence < 0:
                return
            # Reject duplicate/replayed datagrams within one receiver process session.
            if carframework_metrics.get("session_id") == session_id and sequence <= int(carframework_metrics.get("sequence", -1)):
                return
            now = time.time()

            def finite_number(name: str, default=None):
                value = data.get(name)
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    return default
                value = float(value)
                return value if math.isfinite(value) and value >= 0 else default

            clean = {
                "session_id": session_id,
                "sequence": sequence,
                "timestamp": timestamp,
                "last_frame_age_seconds": finite_number("last_frame_age_seconds"),
                "receiver_state": str(data.get("receiver_state", "unknown"))[:40],
                "handshake_established": data.get("handshake_established") is True,
                "total_datagrams": int(finite_number("total_datagrams", 0)),
                "valid_frames": int(finite_number("valid_frames", 0)),
                "frames_per_second": finite_number("frames_per_second", 0.0),
                "receive_megabytes_per_second": finite_number("receive_megabytes_per_second", 0.0),
                "last_frame_size_bytes": int(finite_number("last_frame_size_bytes")) if finite_number("last_frame_size_bytes") is not None else None,
                "processing_ms": finite_number("processing_ms"),
                "decrypt_errors": int(finite_number("decrypt_errors", 0)),
                "decode_errors": int(finite_number("decode_errors", 0)),
                "sender_ip": str(data.get("sender_ip", ""))[:64],
                "sender_port": int(finite_number("sender_port", 0)),
            }
            carframework_metrics = clean | {"reporter_ip": str(addr[0])}
            carframework_metrics_received_at = now
        except (ValueError, TypeError, UnicodeDecodeError, json.JSONDecodeError):
            return


@app.on_event("startup")
async def on_startup() -> None:
    global metrics_udp_transport, metrics_listener_active
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    if not ROBOT_DEVICE_TOKEN:
        print("[Aurora Glass] ROBOT_DEVICE_TOKEN is not set; dashboard WebSocket device connections will be rejected.")
    if not CARFRAMEWORK_METRICS_TOKEN:
        print("[Aurora Glass] CarFramework metrics reporter is not configured; live UDP receiver metrics will remain unavailable.")
    else:
        try:
            loop = asyncio.get_running_loop()
            metrics_udp_transport, _ = await loop.create_datagram_endpoint(
                SignedMetricsProtocol,
                local_addr=(CARFRAMEWORK_METRICS_BIND, CARFRAMEWORK_METRICS_PORT),
            )
            metrics_listener_active = True
            print(f"[Aurora Glass] Listening for signed CarFramework receiver metrics on UDP {CARFRAMEWORK_METRICS_BIND}:{CARFRAMEWORK_METRICS_PORT}.")
        except OSError as exc:
            metrics_listener_active = False
            print(f"[Aurora Glass] Could not bind metrics UDP port {CARFRAMEWORK_METRICS_PORT}: {exc}")
    print(f"[Aurora Glass] Database: {DB_PATH}")
    if not COOKIE_SECURE:
        print("[Aurora Glass] Local-development cookie mode. Use HTTPS and AVIF_COOKIE_SECURE=1 outside a trusted LAN.")


@app.on_event("shutdown")
async def on_shutdown() -> None:
    global metrics_udp_transport, metrics_listener_active
    if metrics_udp_transport is not None:
        metrics_udp_transport.close()
        metrics_udp_transport = None
    metrics_listener_active = False


def read_carframework_source_config() -> dict:
    """Read settings from the actual checkout instead of mirroring hard-coded UI labels."""
    root = CARFRAMEWORK_ROOT.resolve()
    paths = {name: root / name for name in ("sender.py", "reciever.py", "encryption.py")}
    found = {name: path.is_file() for name, path in paths.items()}
    if not found["encryption.py"]:
        return {
            "source_root": str(root),
            "source_files": found,
            "source_available": False,
            "key_establishment": None,
            "signature_scheme": None,
            "key_derivation": None,
            "aead": None,
            "control_port": None,
            "video_port": None,
            "sender_destination": None,
            "configured_nonce_bytes": None,
            "required_nonce_bytes": 12,
            "nonce_compatible": None,
            "metrics_reporter_in_receiver": False,
            "local_key_files": {},
        }

    encryption = paths["encryption.py"].read_text(encoding="utf-8", errors="replace")
    sender = paths["sender.py"].read_text(encoding="utf-8", errors="replace") if found["sender.py"] else ""
    receiver = paths["reciever.py"].read_text(encoding="utf-8", errors="replace") if found["reciever.py"] else ""
    kem = "ML-KEM-768" if re.search(r"MLKEM768", encryption) else None
    signature_match = re.search(r"MLDSA(44|65|87)", encryption, re.IGNORECASE)
    signature = f"ML-DSA-{signature_match.group(1)}" if signature_match else None
    nonce_match = re.search(r"^\s*NONCE_LEN\s*=\s*(\d+)", encryption, re.MULTILINE)
    control_match = re.search(r"^\s*CONTROL_PORT\s*=\s*(\d+)", encryption, re.MULTILINE)
    video_match = re.search(r"^\s*VIDEO_PORT\s*=\s*(\d+)", encryption, re.MULTILINE)
    dest_match = re.search(r"^\s*DEST\s*=\s*\(\s*['\"]([^'\"]+)['\"]\s*,\s*(\d+)\s*\)", sender, re.MULTILINE)
    nonce_bytes = int(nonce_match.group(1)) if nonce_match else None
    key_files = (
        "sender_mldsa_sk.bin", "sender_mldsa_pk.bin",
        "receiver_mldsa_sk.bin", "receiver_mldsa_pk.bin",
    )
    local_key_files = {name: (root / name).is_file() for name in key_files}
    return {
        "source_root": str(root),
        "source_files": found,
        "source_available": all(found.values()),
        "key_establishment": kem,
        "signature_scheme": signature,
        "key_derivation": "HKDF" if re.search(r"\bHKDF\b", encryption, re.IGNORECASE) else "No HKDF detected",
        "aead": "AES-256-GCM-SIV" if "AESGCMSIV" in encryption else None,
        "control_port": int(control_match.group(1)) if control_match else None,
        "video_port": int(video_match.group(1)) if video_match else None,
        "sender_destination": f"{dest_match.group(1)}:{dest_match.group(2)}" if dest_match else None,
        "configured_nonce_bytes": nonce_bytes,
        "required_nonce_bytes": 12,
        "nonce_compatible": nonce_bytes == 12 if nonce_bytes is not None else None,
        "metrics_reporter_in_receiver": "carframework_metrics" in receiver and "CARFRAMEWORK_METRICS_HOST" in receiver,
        "local_key_files": local_key_files,
    }


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "version": app.version,
        "robot_configured": bool(ROBOT_DEVICE_TOKEN),
        "metrics_reporter_configured": bool(CARFRAMEWORK_METRICS_TOKEN),
        "metrics_listener_active": metrics_listener_active,
    }


@app.get("/api/metrics")
def operational_metrics(request: Request) -> dict:
    require_user(request)
    now = time.time()
    async_samples = list(ws_frame_samples)
    while async_samples and now - async_samples[0][0] > 5:
        async_samples.pop(0)
    ws_recent = latest_frame_at is not None and now - latest_frame_at <= 5
    udp_age = now - carframework_metrics_received_at if carframework_metrics_received_at is not None else None
    udp_recent = udp_age is not None and udp_age <= 5

    if udp_recent and carframework_metrics.get("receiver_state") != "stopped":
        source = "carframework_udp_receiver"
        receiver_connected = True
        reported_frame_age = carframework_metrics.get("last_frame_age_seconds")
        last_frame_age = (reported_frame_age + udp_age) if reported_frame_age is not None else None
        video_live = last_frame_age is not None and last_frame_age <= 5
        video = {
            "source": source,
            "receiver_connected": receiver_connected,
            "live": video_live,
            "receiver_state": carframework_metrics.get("receiver_state"),
            "frames_per_second": carframework_metrics.get("frames_per_second"),
            "last_frame_size_bytes": carframework_metrics.get("last_frame_size_bytes"),
            "receive_megabytes_per_second": carframework_metrics.get("receive_megabytes_per_second"),
            "processing_ms": carframework_metrics.get("processing_ms"),
            "frames_total": carframework_metrics.get("valid_frames"),
            "datagrams_total": carframework_metrics.get("total_datagrams"),
            "last_frame_age_seconds": last_frame_age,
            "sender_ip": carframework_metrics.get("sender_ip") or None,
            "reporter_ip": carframework_metrics.get("reporter_ip"),
            "decrypt_errors": carframework_metrics.get("decrypt_errors"),
            "decode_errors": carframework_metrics.get("decode_errors"),
            "report_age_seconds": udp_age,
        }
    elif ws_recent:
        span = max(async_samples[-1][0] - async_samples[0][0], 0.001) if len(async_samples) > 1 else 1.0
        ws_fps = (len(async_samples) - 1) / span if len(async_samples) > 1 else 0.0
        ws_bytes = sum(size for _, size in async_samples)
        rate_span = max(min(now - async_samples[0][0], 5.0), 1.0)
        video = {
            "source": "dashboard_websocket_jpeg",
            "receiver_connected": True,
            "live": True,
            "receiver_state": "receiving",
            "frames_per_second": round(ws_fps, 2),
            "last_frame_size_bytes": async_samples[-1][1] if async_samples else None,
            "receive_megabytes_per_second": round(ws_bytes / rate_span / 1_000_000, 4),
            "processing_ms": None,
            "frames_total": frames_received,
            "datagrams_total": None,
            "last_frame_age_seconds": max(0.0, now - latest_frame_at) if latest_frame_at else None,
            "sender_ip": None,
            "reporter_ip": None,
            "decrypt_errors": None,
            "decode_errors": None,
            "report_age_seconds": None,
        }
    else:
        video = {
            "source": None,
            "receiver_connected": False,
            "live": False,
            "receiver_state": "no_data",
            "frames_per_second": None,
            "last_frame_size_bytes": None,
            "receive_megabytes_per_second": None,
            "processing_ms": None,
            "frames_total": None,
            "datagrams_total": None,
            "last_frame_age_seconds": None,
            "sender_ip": None,
            "reporter_ip": None,
            "decrypt_errors": None,
            "decode_errors": None,
            "report_age_seconds": None,
        }

    telemetry_fresh = robot_telemetry_at is not None and now - robot_telemetry_at <= 5
    return {
        "server": {
            "uptime_seconds": round(time.monotonic() - APP_STARTED_MONOTONIC, 1),
            "api_online": True,
        },
        "video": video,
        "robot": {
            "control_connected": bool(robot_clients),
            "telemetry": dict(robot_telemetry) if telemetry_fresh else {},
            "telemetry_age_seconds": round(now - robot_telemetry_at, 2) if telemetry_fresh else None,
        },
        "metrics_reporter": {
            "configured": bool(CARFRAMEWORK_METRICS_TOKEN),
            "listener_active": metrics_listener_active,
            "bind": CARFRAMEWORK_METRICS_BIND if metrics_listener_active else None,
            "port": CARFRAMEWORK_METRICS_PORT if metrics_listener_active else None,
        },
    }


@app.get("/api/security/status")
def security_status(request: Request) -> dict:
    require_user(request)
    source = read_carframework_source_config()
    reporter_recent = carframework_metrics_received_at is not None and time.time() - carframework_metrics_received_at <= 5
    frame_processed = reporter_recent and int(carframework_metrics.get("valid_frames", 0)) > 0
    nonce_ok = source.get("nonce_compatible")
    problems = []
    if not source["source_available"]:
        problems.append("CarFramework sender.py, reciever.py, and encryption.py were not all found. Set CARFRAMEWORK_ROOT to the checkout path.")
    if nonce_ok is False:
        problems.append(f"The source sets NONCE_LEN={source['configured_nonce_bytes']}; AES-GCM-SIV requires 12 bytes.")
    if source.get("key_derivation") == "No HKDF detected":
        problems.append("No HKDF key derivation was detected in encryption.py.")
    if not source.get("metrics_reporter_in_receiver"):
        problems.append("The installed reciever.py does not contain the signed metrics reporter yet.")
    if not CARFRAMEWORK_METRICS_TOKEN:
        problems.append("CARFRAMEWORK_METRICS_TOKEN is not configured in the dashboard process.")
    if not metrics_listener_active:
        problems.append("The dashboard metrics UDP listener is not active.")
    if not frame_processed:
        problems.append("No successfully decrypted and decoded CarFramework video frame has been reported in the last 5 seconds.")
    return {
        "pqc_transport_enabled": False,
        "pqc_handshake_code_present": bool(source.get("key_establishment") and source.get("signature_scheme")),
        "source_available": source["source_available"],
        "source_files": source["source_files"],
        "robot_token_configured": bool(ROBOT_DEVICE_TOKEN),
        "secure_cookie_configured": COOKIE_SECURE,
        "metrics_reporter_configured": bool(CARFRAMEWORK_METRICS_TOKEN),
        "metrics_listener_active": metrics_listener_active,
        "receiver_reporter_recent": reporter_recent,
        "receiver_handshake_reported": reporter_recent and carframework_metrics.get("handshake_established") is True,
        "receiver_processed_frame": frame_processed,
        "receiver_state": carframework_metrics.get("receiver_state") if reporter_recent else None,
        "receiver_datagrams": carframework_metrics.get("total_datagrams") if reporter_recent else None,
        "receiver_decrypt_errors": carframework_metrics.get("decrypt_errors") if reporter_recent else None,
        "receiver_decode_errors": carframework_metrics.get("decode_errors") if reporter_recent else None,
        "receiver_sender_ip": carframework_metrics.get("sender_ip") if reporter_recent else None,
        "receiver_report_age_seconds": round(time.time() - carframework_metrics_received_at, 2) if reporter_recent and carframework_metrics_received_at else None,
        "carframework": source,
        "message": " ".join(problems) if problems else "Receiver metrics are live. The UI can observe decoded video activity, but it does not independently attest the cryptographic implementation; treat PQC as unverified until the protocol has been reviewed and tested.",
    }


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
    global latest_frame, latest_frame_at, frames_received, robot_telemetry, robot_telemetry_at
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
                frame_now = time.time()
                async with state_lock:
                    latest_frame = binary
                    latest_frame_at = frame_now
                    frames_received += 1
                    ws_frame_samples.append((frame_now, len(binary)))
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
                        for key in ("battery", "sensor_left", "sensor_right", "mode", "line_detected", "position_x", "position_y"):
                            value = data.get(key)
                            if key == "battery" and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and 0 <= float(value) <= 100:
                                clean[key] = float(value)
                            elif key in ("sensor_left", "sensor_right", "position_x", "position_y") and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
                                clean[key] = float(value)
                            elif key == "mode" and isinstance(value, str):
                                clean[key] = value[:32]
                            elif key == "line_detected" and isinstance(value, bool):
                                clean[key] = value
                        async with state_lock:
                            robot_telemetry = clean
                            robot_telemetry_at = time.time()
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
                if not robot_clients:
                    robot_telemetry = {}
                    robot_telemetry_at = None
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
