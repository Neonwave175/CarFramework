"""Receive/decrypt CarFramework AVIF UDP frames and optionally report live metrics.

The metrics side-channel is disabled unless CARFRAMEWORK_METRICS_HOST and
CARFRAMEWORK_METRICS_TOKEN are both configured. It sends no image data, keys,
or cryptographic material; reports are HMAC-SHA256 authenticated.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import socket
import statistics
import time
from collections import deque

import cv2
import numpy as np

from encryption import mldsa_load_public_key, mldsa_load_private_key, receiver_exchange, decrypt

CONTROL_PORT = 5006
VIDEO_PORT = 5005
DEFAULT_METRICS_PORT = 5007
METRICS_INTERVAL_SECONDS = 1.0
METRICS_WINDOW_SECONDS = 5.0


class ReceiverMetrics:
    """Observe real receiver work and emit a small authenticated UDP status packet."""

    def __init__(self, host: str, port: int, token: str):
        self.host = host
        self.port = port
        self.token = token.encode("utf-8")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.session_id = secrets.token_hex(12)
        self.sequence = 0
        self.last_report = 0.0
        self.wire_samples: deque[tuple[float, int]] = deque()
        self.frame_times: deque[float] = deque()
        self.processing_samples: deque[float] = deque(maxlen=30)
        self.total_datagrams = 0
        self.valid_frames = 0
        self.decrypt_errors = 0
        self.decode_errors = 0
        self.last_frame_size_bytes: int | None = None
        self.last_frame_monotonic: float | None = None
        self.last_sender_ip = ""
        self.last_sender_port = 0

    @classmethod
    def from_environment(cls) -> "ReceiverMetrics | None":
        host = os.environ.get("CARFRAMEWORK_METRICS_HOST", "").strip()
        token = os.environ.get("CARFRAMEWORK_METRICS_TOKEN", "").strip()
        if not host or not token:
            print("[CarFramework] Metrics reporter disabled. Set CARFRAMEWORK_METRICS_HOST and CARFRAMEWORK_METRICS_TOKEN to publish real receiver stats.")
            return None
        try:
            port = int(os.environ.get("CARFRAMEWORK_METRICS_PORT", str(DEFAULT_METRICS_PORT)))
        except ValueError:
            port = DEFAULT_METRICS_PORT
        if not 1024 <= port <= 65535:
            port = DEFAULT_METRICS_PORT
        return cls(host, port, token)

    def record_datagram(self, packet_size: int, sender: tuple[str, int]) -> None:
        now = time.monotonic()
        self.total_datagrams += 1
        self.wire_samples.append((now, packet_size))
        self.last_sender_ip, self.last_sender_port = sender[0], int(sender[1])
        self._prune(now)

    def record_decrypt_error(self) -> None:
        self.decrypt_errors += 1

    def record_decode_error(self) -> None:
        self.decode_errors += 1

    def record_frame(self, avif_size: int, processing_ms: float) -> None:
        now_mono = time.monotonic()
        self.valid_frames += 1
        self.frame_times.append(now_mono)
        self.processing_samples.append(max(0.0, float(processing_ms)))
        self.last_frame_size_bytes = int(avif_size)
        self.last_frame_monotonic = now_mono
        self._prune(now_mono)

    def _prune(self, now_mono: float) -> None:
        cutoff = now_mono - METRICS_WINDOW_SECONDS
        while self.wire_samples and self.wire_samples[0][0] < cutoff:
            self.wire_samples.popleft()
        while self.frame_times and self.frame_times[0] < cutoff:
            self.frame_times.popleft()

    def report(self, receiver_state: str, *, force: bool = False) -> None:
        if not force and time.monotonic() - self.last_report < METRICS_INTERVAL_SECONDS:
            return
        now_mono = time.monotonic()
        self._prune(now_mono)
        self.sequence += 1

        if len(self.frame_times) >= 2:
            elapsed = max(self.frame_times[-1] - self.frame_times[0], 0.001)
            fps = (len(self.frame_times) - 1) / elapsed
        else:
            fps = 0.0

        if self.wire_samples:
            elapsed = max(min(now_mono - self.wire_samples[0][0], METRICS_WINDOW_SECONDS), 1.0)
            rx_mb_s = sum(size for _, size in self.wire_samples) / elapsed / 1_000_000
        else:
            rx_mb_s = 0.0

        processing_ms = statistics.fmean(self.processing_samples) if self.processing_samples else None
        frame_age = (now_mono - self.last_frame_monotonic) if self.last_frame_monotonic is not None else None
        payload = {
            "type": "carframework_metrics",
            "version": 1,
            "session_id": self.session_id,
            "sequence": self.sequence,
            "timestamp": time.time(),
            "last_frame_age_seconds": frame_age,
            "receiver_state": receiver_state,
            # This flag is emitted only after receiver_exchange() returned successfully.
            "handshake_established": True,
            "total_datagrams": self.total_datagrams,
            "valid_frames": self.valid_frames,
            "frames_per_second": round(max(0.0, fps), 3),
            "receive_megabytes_per_second": round(max(0.0, rx_mb_s), 6),
            "last_frame_size_bytes": self.last_frame_size_bytes,
            # Measured around decrypt() + cv2.imdecode(), not sender-side encoding.
            "processing_ms": round(processing_ms, 3) if processing_ms is not None else None,
            "decrypt_errors": self.decrypt_errors,
            "decode_errors": self.decode_errors,
            "sender_ip": self.last_sender_ip,
            "sender_port": self.last_sender_port,
        }
        body = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
        signature = hmac.new(self.token, body, hashlib.sha256).hexdigest().encode("ascii")
        try:
            self.sock.sendto(signature + b"." + body, (self.host, self.port))
            self.last_report = now_mono
        except OSError as exc:
            # A dashboard/network outage must not stop video reception.
            print(f"[CarFramework] Metrics report failed: {exc}")
            self.last_report = now_mono

    def close(self) -> None:
        self.sock.close()


def main():
    trusted_sender_pk = mldsa_load_public_key("sender_mldsa_pk.bin")
    receiver_sk = mldsa_load_private_key("receiver_mldsa_sk.bin")
    key = receiver_exchange(trusted_sender_pk, receiver_sk)
    print("Encryption key established")

    metrics = ReceiverMetrics.from_environment()
    if metrics:
        metrics.report("waiting_for_frames", force=True)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    sock.settimeout(1.0)
    sock.bind(("0.0.0.0", VIDEO_PORT))
    print(f"Listening for encrypted AVIF datagrams on UDP {VIDEO_PORT}")

    try:
        while True:
            try:
                data, addr = sock.recvfrom(65535)
            except socket.timeout:
                if metrics:
                    last_good_age = time.monotonic() - metrics.last_frame_monotonic if metrics.last_frame_monotonic is not None else None
                    state = "receiving" if last_good_age is not None and last_good_age <= 5 else "waiting_for_frames"
                    metrics.report(state)
                continue

            if metrics:
                metrics.record_datagram(len(data), addr)

            process_started = time.perf_counter()
            try:
                frame_bytes = decrypt(data, key)
            except Exception as exc:
                print("Decrypt failed:", exc)
                if metrics:
                    metrics.record_decrypt_error()
                    metrics.report("decrypt_error")
                continue

            frame = cv2.imdecode(np.frombuffer(frame_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                print("Decode failed")
                if metrics:
                    metrics.record_decode_error()
                    metrics.report("decode_error")
                continue

            if metrics:
                processing_ms = (time.perf_counter() - process_started) * 1000
                metrics.record_frame(len(frame_bytes), processing_ms)
                metrics.report("receiving")

            cv2.imshow("UDP video", frame)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
    except KeyboardInterrupt:
        print("\nStopped by user")
    finally:
        sock.close()
        if metrics:
            metrics.report("stopped", force=True)
            metrics.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
