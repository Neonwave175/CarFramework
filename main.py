import asyncio

import cv2
from sender import compress_send
from trackhuman import track_human


async def capture(q, stop):
    cap = cv2.VideoCapture(0)
    try:
        while not stop.is_set():
            ret, frame = await asyncio.to_thread(cap.read)
            if not ret:
                print("No camera frame available. Check camera access.")
                stop.set()
                break
            if q.full():
                q.get_nowait()
            q.put_nowait(frame)
    finally:
        cap.release()
        if q.full():
            q.get_nowait()
        q.put_nowait(None)

async def main():
    q = asyncio.Queue(maxsize=1)
    dets_q = asyncio.Queue(maxsize=1)
    stop = asyncio.Event()
    await asyncio.gather(
        capture(q, stop),
        compress_send(q, dets_q, stop),
        track_human(dets_q, stop),
    )

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Stopped by user")
