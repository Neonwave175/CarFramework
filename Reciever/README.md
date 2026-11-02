# CarView

An Electron desktop interface backed by a Rust UDP receiver for the CarFramework video stream. The Rust process binds UDP 5005 and passes encrypted datagrams to a small Python worker. The worker calls the existing `../encryption.py` for the authenticated key exchange on UDP 5006 and for decryption. Electron displays the resulting AVIF frames. This is a desktop app; Electron and the crypto worker are separate from the Rust executable.

## Requirements

- Rust and Cargo.
- Node.js and npm; Electron is installed locally by npm.
- Python 3 with a version of `cryptography` that provides `MLKEM768`, `MLDSA44`, and `AESGCMSIV` (the same requirements as the existing framework).
- The sender's trusted ML-DSA public key and the receiver's ML-DSA private key, in the existing raw formats.

From this directory, run `npm install` and `npm start`. The latter builds the Rust process in release mode and launches Electron. Select the key files and, if necessary, enter the full path to the Python executable for the environment containing the dependency. Start the receiver before starting the sender; they must have network access to UDP ports 5005 and 5006. Update the sender's hard-coded destination IP to this computer's reachable address.

## Current protocol blocker

The repository currently sets `NONCE_LEN = 192` in `encryption.py`; AES-GCM-SIV requires a **12-byte** nonce. Consequently the original sender cannot encrypt frames, and this app reports the problem rather than claiming a connection. Change the protocol consistently on both the sender and receiver copies before expecting a video stream. This app does not change the framework's protocol. Large frames may also exceed UDP's maximum datagram size because the sender does not fragment them. Do not run this app and `reciever.py` on the same ports simultaneously.

The receiver has not been tested against live hardware. It does not connect to robot controls or the WebSocket dashboard from the pull request.
