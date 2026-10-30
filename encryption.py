"""Post-quantum video encryption."""

import os
import socket
import time
from cryptography.hazmat.primitives.asymmetric import mlkem, mldsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCMSIV
from cryptography.exceptions import InvalidSignature

MLKEM_PK_LEN = 1184
MLKEM_CT_LEN = 1088
CONTROL_PORT = 5006
VIDEO_PORT = 5005
NONCE_LEN = 12


def encrypt(plaintext: bytes, key: bytes) -> bytes:
    nonce = os.urandom(NONCE_LEN)
    aead = AESGCMSIV(key)
    return nonce + aead.encrypt(nonce, plaintext, None)


def decrypt(data: bytes, key: bytes) -> bytes:
    nonce = data[:NONCE_LEN]
    aead = AESGCMSIV(key)
    return aead.decrypt(nonce, data[NONCE_LEN:], None)


def mlkem_keypair():
    sk = mlkem.MLKEM768PrivateKey.generate()
    return sk, sk.public_key().public_bytes_raw()


def mlkem_encapsulate(pk_raw: bytes):
    pk = mlkem.MLKEM768PublicKey.from_public_bytes(pk_raw)
    ss, ct = pk.encapsulate()
    return ct, ss


def mlkem_decapsulate(sk, ct: bytes) -> bytes:
    return sk.decapsulate(ct)


def mldsa_keypair():
    sk = mldsa.MLDSA44PrivateKey.generate()
    return sk, sk.public_key().public_bytes_raw()


def mldsa_load_private_key(path: str):
    with open(path, "rb") as f:
        seed = f.read()
    return mldsa.MLDSA44PrivateKey.from_seed_bytes(seed)


def mldsa_load_public_key(path: str) -> bytes:
    with open(path, "rb") as f:
        return f.read()


def mldsa_sign(sk, message: bytes) -> bytes:
    return sk.sign(message)


def mldsa_verify(pk_raw: bytes, message: bytes, signature: bytes) -> bool:
    pk = mldsa.MLDSA44PublicKey.from_public_bytes(pk_raw)
    try:
        pk.verify(signature, message)
        return True
    except InvalidSignature:
        return False


def sender_exchange(dest_ip: str, mldsa_sk, receiver_mldsa_pk: bytes) -> bytes:
    sk_kem, pk_kem = mlkem_keypair()
    signature = mldsa_sign(mldsa_sk, pk_kem)

    ctrl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ctrl.settimeout(0.5)
    try:
        for _ in range(20):
            ctrl.sendto(pk_kem + signature, (dest_ip, CONTROL_PORT))
            try:
                resp, _ = ctrl.recvfrom(4096)
                if len(resp) < MLKEM_CT_LEN + 1:
                    continue
                ct = resp[:MLKEM_CT_LEN]
                sig = resp[MLKEM_CT_LEN:]
                if not mldsa_verify(receiver_mldsa_pk, ct, sig):
                    continue
                return mlkem_decapsulate(sk_kem, ct)
            except socket.timeout:
                continue
        raise RuntimeError("ML-KEM key exchange timeout")
    finally:
        ctrl.close()


def receiver_exchange(trusted_sender_mldsa_pk: bytes, receiver_mldsa_sk, timeout: float = 30.0) -> bytes:
    ctrl = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ctrl.bind(("0.0.0.0", CONTROL_PORT))
    ctrl.settimeout(1.0)
    deadline = time.monotonic() + timeout
    try:
        while time.monotonic() < deadline:
            try:
                msg, addr = ctrl.recvfrom(4096)
            except socket.timeout:
                continue
            if len(msg) <= MLKEM_PK_LEN:
                continue
            pk_kem = msg[:MLKEM_PK_LEN]
            signature = msg[MLKEM_PK_LEN:]
            if mldsa_verify(trusted_sender_mldsa_pk, pk_kem, signature):
                ct, ss = mlkem_encapsulate(pk_kem)
                sig = mldsa_sign(receiver_mldsa_sk, ct)
                ctrl.sendto(ct + sig, addr)
                return ss
        raise RuntimeError("ML-KEM key exchange timeout")
    finally:
        ctrl.close()
