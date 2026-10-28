#!/usr/bin/env python3
"""AVIF Lab camera sender for a Raspberry Pi + CSI camera.

Uses the Raspberry Pi-supported Picamera2 camera API, then sends JPEG frames
as binary WebSocket messages to the AVIF Lab API. It uses the same protocol as
the bundled ESP32-CAM sample, so the dashboard/server does not need changes.

Install Raspberry Pi OS packages:
    sudo apt update
    sudo apt install -y python3-picamera2 python3-websockets

Set AVIF_WS_URL and ROBOT_DEVICE_TOKEN before running. Motor functions below
are deliberately placeholders; connect them to your motor driver before using
manual dashboard commands. Keep a hardware-side motor watchdog and kill switch.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import signal
import time
from typing import Any

import websockets
from picamera2 import Picamera2

WS_URL = os.environ.get(
    "AVIF_WS_URL", "ws://192.168.1.100:8000/ws/robot/camera"
).strip()
DEVICE_TOKEN = os.environ.get("ROBOT_DEVICE_TOKEN", "").strip()
WIDTH = max(160, min(1920, int(os.environ.get("AVIF_CAMERA_WIDTH", "640"))))
HEIGHT = max(120, min(1080, int(os.environ.get("AVIF_CAMERA_HEIGHT", "480"))))
FPS = max(1.0, min(15.0, float(os.environ.get("AVIF_CAMERA_FPS", "8"))))
JPEG_QUALITY = max(30, min(90, int(os.environ.get("AVIF_CAMERA_QUALITY", "70"))))
MAX_FRAME_BYTES = 1_500_000

# TODO: Replace these logging stubs with your actual GPIO/motor-driver logic.
# For now this script streams the camera and accepts/logs allowed commands only.
def stop_motors() -> None:
    print("[robot] STOP requested (motor-driver stub; no GPIO configured)")


def apply_motor_command(command: str, speed: float) -> None:
    print(
        f"[robot] command={command}, speed={speed:.2f} "
        "(motor-driver stub; no GPIO configured)"
    )


async def receive_commands(ws: Any) -> None:
    """Read server messages so commands/status do not build up in the socket."""
    stop_handle = None
    try:
        async for message in ws:
            if isinstance(message, bytes):
                continue
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                print("[api] Ignored malformed text message")
                continue

            kind = payload.get("type") if isinstance(payload, dict) else None
            if kind == "command":
                command = str(payload.get("command", "stop"))
                if command == "stop":
                    if stop_handle is not None:
                        stop_handle.cancel()
                    stop_motors()
                    continue
                if command not in {"forward", "reverse", "left", "right"}:
                    stop_motors()
                    continue
                try:
                    speed = float(payload.get("speed", 0.0))
                except (TypeError, ValueError):
                    speed = 0.0
                speed = max(0.0, min(0.22, speed))
                apply_motor_command(command, speed)
                # Commands from AVIF Lab are short pulses. This timer only logs a
                # stop; real firmware must implement a hardware-side watchdog.
                duration_ms = int(payload.get("duration_ms", 300) or 300)
                duration_ms = max(1, min(500, duration_ms))
                if stop_handle is not None:
                    stop_handle.cancel()
                stop_handle = asyncio.get_running_loop().call_later(
                    duration_ms / 1000, stop_motors
                )
            elif kind == "robot_status":
                print(
                    f"[api] robot connected={payload.get('connected')} "
                    f"camera_ready={payload.get('camera_ready')}"
                )
    finally:
        if stop_handle is not None:
            stop_handle.cancel()
        # Best effort only. A real motor controller must also stop in its own
        # watchdog when the network disappears.
        stop_motors()


async def stream_camera(picam2: Picamera2, ws: Any) -> None:
    period = 1.0 / FPS
    frames = 0
    started = time.monotonic()
    while True:
        tick = time.monotonic()
        buffer = io.BytesIO()
        # Picamera2 supports writing JPEG captures to an in-memory file object.
        picam2.capture_file(buffer, format="jpeg")
        frame = buffer.getvalue()
        if 4 <= len(frame) <= MAX_FRAME_BYTES and frame.startswith(b"\xff\xd8") and frame.endswith(b"\xff\xd9"):
            await ws.send(frame)
            frames += 1
            if frames % 40 == 0:
                elapsed = max(0.001, time.monotonic() - started)
                print(f"[camera] sent {frames} frames ({frames / elapsed:.1f} fps average)")
        else:
            print(f"[camera] skipped invalid/oversized JPEG frame ({len(frame)} bytes)")
        await asyncio.sleep(max(0.0, period - (time.monotonic() - tick)))


async def run_connection(picam2: Picamera2, stop_event: asyncio.Event) -> None:
    print(f"[api] Connecting to {WS_URL}")
    # JPEG is already compressed; disabling WebSocket per-message compression
    # avoids spending CPU compressing it a second time.
    async with websockets.connect(
        WS_URL,
        open_timeout=8,
        ping_interval=15,
        ping_timeout=15,
        max_size=2_000_000,
        compression=None,
    ) as ws:
        await ws.send(json.dumps({"type": "auth", "token": DEVICE_TOKEN}))
        raw_reply = await asyncio.wait_for(ws.recv(), timeout=8)
        if isinstance(raw_reply, bytes):
            raise RuntimeError("API returned binary data before authentication")
        reply = json.loads(raw_reply)
        if reply.get("type") != "auth" or reply.get("ok") is not True:
            raise RuntimeError(f"API rejected device authentication: {reply}")
        print("[api] Device authenticated; streaming JPEG frames")
        send_task = asyncio.create_task(stream_camera(picam2, ws))
        recv_task = asyncio.create_task(receive_commands(ws))
        stop_task = asyncio.create_task(stop_event.wait())
        tasks = {send_task, recv_task, stop_task}
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if stop_task in done:
            return
        for task in done:
            if task is stop_task:
                continue
            exception = task.exception()
            if exception:
                raise exception


async def main() -> None:
    if not DEVICE_TOKEN:
        raise SystemExit(
            "Set ROBOT_DEVICE_TOKEN to the same secret configured for the AVIF Lab server."
        )
    if not WS_URL.startswith(("ws://", "wss://")):
        raise SystemExit("AVIF_WS_URL must start with ws:// or wss://")

    picam2 = Picamera2()
    config = picam2.create_video_configuration(
        main={"size": (WIDTH, HEIGHT), "format": "RGB888"},
        controls={"FrameRate": FPS},
        buffer_count=4,
    )
    picam2.configure(config)
    picam2.options["quality"] = JPEG_QUALITY
    picam2.start()
    time.sleep(1.0)  # allow automatic exposure/white balance to settle
    print(f"[camera] ready: {WIDTH}x{HEIGHT}, target {FPS:g} fps, JPEG quality {JPEG_QUALITY}")
    print("[safety] motor functions are placeholders; no GPIO pins are configured")

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            pass

    try:
        while not stop_event.is_set():
            try:
                await run_connection(picam2, stop_event)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                stop_motors()
                print(f"[api] Connection ended: {exc}. Reconnecting in 3 seconds.")
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=3)
                except asyncio.TimeoutError:
                    pass
    finally:
        stop_motors()
        picam2.stop()
        picam2.close()
        print("[camera] shut down")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
