import cv2
import socket
import numpy as np

from encryption import mldsa_load_public_key, mldsa_load_private_key, receiver_exchange, decrypt

CONTROL_PORT = 5006
VIDEO_PORT = 5005


def main():
    trusted_sender_pk = mldsa_load_public_key("sender_mldsa_pk.bin")
    receiver_sk = mldsa_load_private_key("receiver_mldsa_sk.bin")
    key = receiver_exchange(trusted_sender_pk, receiver_sk)
    print("Encryption key established")

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
    sock.bind(("0.0.0.0", VIDEO_PORT))

    try:
        while True:
            data, addr = sock.recvfrom(65535)
            try:
                frame_bytes = decrypt(data, key)
            except Exception as e:
                print("Decrypt failed:", e)
                continue

            frame = cv2.imdecode(np.frombuffer(frame_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            if frame is None:
                print("Decode failed")
                continue

            cv2.imshow("UDP video", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break
    except KeyboardInterrupt:
        print("\nStopped by user")
    finally:
        sock.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
