import asyncio
import socket

import cv2
from mpipe import Analyser

DEST = ("192.168.68.57", 5005)
PARAMS = [cv2.IMWRITE_AVIF_QUALITY, 50]

analyser = Analyser()

def encode(frame):
    ok, buf = cv2.imencode('.avif', frame, PARAMS)
    return buf.tobytes() if ok else None

async def compress_send(q, dets_q, stop):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        while not stop.is_set():
            frame = await q.get()
            if frame is None:
                break
            result = await analyser(frame)
            if result is None:
                continue
            if dets_q.full():
                dets_q.get_nowait()
            dets_q.put_nowait(analyser.last)
            data = await asyncio.to_thread(encode, result)
            if data is None:
                print("Encode failed")
                continue
            sock.sendto(data, DEST)
    finally:
        sock.close()
