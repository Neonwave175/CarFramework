import asyncio
import socket
import cv2
from mpipe import Analyser

from encryption import mldsa_load_private_key, mldsa_load_public_key, sender_exchange, encrypt

DEST = ("192.168.68.57", 5005)
PARAMS = [cv2.IMWRITE_AVIF_QUALITY, 50]

analyser = Analyser()


def encode(frame):
    ok, buf = cv2.imencode('.avif', frame, PARAMS)
    return buf.tobytes() if ok else None


async def compress_send(q, dets_q, stop):
    mldsa_sk = mldsa_load_private_key("sender_mldsa_sk.bin")
    receiver_pk = mldsa_load_public_key("receiver_mldsa_pk.bin")
    key = await asyncio.to_thread(sender_exchange, DEST[0], mldsa_sk, receiver_pk)
    print("Encryption key established")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        while not stop.is_set():
            frame = await q.get()
            result = await analyser(frame)
            if result is None:
                break
            if dets_q.full():
                dets_q.get_nowait()
            dets_q.put_nowait(analyser.last)
            data = await asyncio.to_thread(encode, result)
            if data is None:
                print("Encode failed")
                continue
            encrypted = encrypt(data, key)
            sock.sendto(encrypted, DEST)
    finally:
        sock.close()
