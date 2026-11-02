"""Bridge to the framework's existing cryptography, without changing its wire format."""
import base64
import os
import sys


def emit(message):
    print(message, flush=True)


def main():
    framework, sender_key, receiver_key = sys.argv[1:]
    sys.path.insert(0, os.path.abspath(framework))
    try:
        import encryption
        # AES-GCM-SIV specifies a 12-byte nonce. Do not pretend the current
        # 192-byte setting can produce a working stream.
        if encryption.NONCE_LEN != 12:
            raise ValueError(f"Framework NONCE_LEN is {encryption.NONCE_LEN}; AES-GCM-SIV requires 12 bytes. Update both sender and receiver together before streaming.")
        trusted = encryption.mldsa_load_public_key(sender_key)
        private = encryption.mldsa_load_private_key(receiver_key)
        key = encryption.receiver_exchange(trusted, private)
    except Exception as exc:
        emit("ERROR " + str(exc).replace("\n", " "))
        return 1
    emit("READY")
    for line in sys.stdin:
        try:
            packet = base64.b64decode(line.strip(), validate=True)
            frame = encryption.decrypt(packet, key)
            emit("FRAME " + base64.b64encode(frame).decode("ascii"))
        except Exception as exc:
            emit("ERROR " + str(exc).replace("\n", " "))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
