# Aurora Glass · CarFramework dashboard

Aurora Glass is the browser dashboard and FastAPI workspace intended to sit alongside the supplied CarFramework project. It keeps the existing visual dashboard, authenticated accounts, media import, settings, and robot-control API.

No board-specific sample firmware or alternate camera client is bundled. The integration notes below follow only the Python files in the supplied `CarFramework-master.zip`.

## Run the dashboard

Use Python 3.11 or newer on the machine hosting the dashboard:

```bash
cd avif-lab-glass-ui
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
export ROBOT_DEVICE_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
uvicorn server:app --host 0.0.0.0 --port 8000
```

On Windows, use `start_windows.ps1` from PowerShell. Open `http://127.0.0.1:8000`, create an account, and sign in. The dashboard uses a server-side SQLite database, salted scrypt password hashes, and an HttpOnly session cookie.

`ROBOT_DEVICE_TOKEN` belongs to the dashboard's separate authenticated WebSocket device API. It is **not** one of the CarFramework ML-DSA key files and does not authenticate the CarFramework UDP sender.

## Supplied CarFramework network configuration

The uploaded CarFramework source defines these roles and settings:

```text
main.py
  └─ cv2.VideoCapture(0)
       └─ sender.py
            ├─ mpipe.Analyser (YOLO detection + pose)
            ├─ cv2.imencode('.avif', ...)
            ├─ encryption.sender_exchange(...)
            └─ encrypted UDP datagrams → DEST = 192.168.68.57:5005

reciever.py
  ├─ encryption.receiver_exchange(...)
  ├─ UDP handshake listener: 0.0.0.0:5006
  ├─ encrypted video listener: 0.0.0.0:5005
  ├─ decrypt + cv2.imdecode(...)
  └─ cv2.imshow("UDP video", frame)
```

| Purpose | Setting in supplied source |
|---|---|
| Sender destination | `192.168.68.57:5005` in `sender.py` |
| Key-exchange/control port | UDP `5006` in `encryption.py` |
| Encrypted AVIF video port | UDP `5005` in `encryption.py` and `reciever.py` |
| Receiver bind address | `0.0.0.0` |
| Frame format | AVIF |
| Capture API | `cv2.VideoCapture(0)` in `main.py` |

The sender's destination address is hardcoded in the uploaded `sender.py`; it is not read from an environment variable. For the provided setup to target a Pi, the `DEST` IP must be the Pi's reachable Wi-Fi/LAN address. The Pi must be the host running `reciever.py` and listening on UDP ports 5005 and 5006. The sender emits each encrypted frame with one `sendto` call; there is no application-level fragmentation in the supplied code, so large frames may exceed the UDP payload limit.

## Important source-level compatibility warning

The dashboard's **WebSocket browser viewer is not the CarFramework UDP receiver**. The existing FastAPI routes `/ws/robot/camera` and `/ws/camera` implement a separate WebSocket path. The uploaded `reciever.py` decrypts AVIF packets and displays them using `cv2.imshow`; it does not forward the frames to this dashboard. This UI package does not bind UDP port 5005 or 5006, so it will not collide with `reciever.py`, but a separate tested frame-forwarding adapter is still needed to display those decrypted frames inside the browser.

There is also a blocker in the supplied cryptography source that must be fixed before claiming the original encrypted stream works: `encryption.py` defines `NONCE_LEN = 192`, while AES-256-GCM-SIV requires a 12-byte nonce. The source uses ML-KEM-768 and **ML-DSA-44** and passes the KEM shared secret directly without a separate key-derivation step. The Security page reports those exact source settings and flags the transport as not operational. This UI update does not modify CarFramework's Python files or silently change its cryptographic protocol.

Do not run two receivers on UDP port 5005. The supplied `reciever.py` already binds that port. The Aurora Glass web application listens on TCP port 8000 by default.

## What works in this UI package

- Aurora Glass responsive dashboard and Video Studio.
- Server-backed registration/login and authenticated browser sessions.
- Authenticated WebSocket viewer routes for a compatible WebSocket camera client.
- Robot command API with an allow-list and short command pulses.
- Local file preview and authenticated media uploads.
- Security status endpoint that reports the supplied CarFramework port and algorithm settings without exposing secrets.

## What is not wired together yet

- The supplied CarFramework encrypted UDP AVIF receiver is not forwarded to `/ws/camera`.
- Dashboard movement controls are not connected to the separate `trackhuman.py` → UNO path.
- The original CarFramework encryption code has the nonce-length incompatibility described above.
- No live hardware test is claimed by this UI package.

## Security notes

- Keep the CarFramework ML-DSA private-key files private and out of Git.
- Keep `ROBOT_DEVICE_TOKEN` private; it is separate from CarFramework's key material.
- `AVIF_COOKIE_SECURE=1` must be used when the dashboard is served over HTTPS.
- The offline Wi-Fi/LAN network does not need internet access, but local network traffic is still exposed to other devices on that network unless the protocol is correctly authenticated and encrypted.
- The Security view is diagnostic. It does not claim post-quantum protection is active merely because the source contains ML-KEM/ML-DSA calls.

## API routes

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create account |
| `POST` | `/api/auth/login` | Sign in |
| `POST` | `/api/auth/logout` | Revoke session |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/health` | API health |
| `GET` | `/api/security/status` | Current dashboard and CarFramework configuration status |
| `GET` | `/api/robot/status` | Authenticated WebSocket device status |
| `POST` | `/api/robot/command` | Send an allow-listed command to a WebSocket device |
| `POST` | `/api/video/upload` | Upload image/video |
| `GET` | `/api/video/{id}` | Download user's uploaded media |
| `WS` | `/ws/robot/camera` | Separate authenticated WebSocket device input |
| `WS` | `/ws/camera` | Authenticated browser viewer for WebSocket-fed frames |

## Project files

- `index.html`, `styles.css`, `app.js`: browser interface
- `server.py`: FastAPI application, auth/session handling, robot WebSocket API, security status
- `requirements.txt`: Python dependencies
- `start_windows.ps1`, `start_linux_mac.sh`: launch helpers
- `data/`: SQLite database created on first run
- `uploads/`: user-uploaded media created on first upload
