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
export CARFRAMEWORK_METRICS_TOKEN="$(python -c 'import secrets; print(secrets.token_hex(32))')"
export CARFRAMEWORK_ROOT="$(cd .. && pwd)"
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

## Live measurements from the actual CarFramework UDP receiver

The overview no longer contains seeded FPS, latency, throughput, network-capacity, or activity values. It starts with `—` / `NO DATA`. Values appear only after a real receiver reports them.

The root `reciever.py` now emits a small signed metrics datagram to the dashboard on UDP port `5007`. It reports measured values only: total datagrams, decoded frames, rolling FPS, incoming encrypted UDP MB/s, latest decrypted AVIF frame size, average receiver-side decrypt+decode time, decrypt/decode error counts, and the camera sender's IP. It sends **no frame bytes, private keys, or session keys**. The receiver continues to listen for video on UDP `5005` and key exchange on UDP `5006`; the metrics listener uses the separate port `5007`.

The metrics packet is authenticated with HMAC-SHA256 using `CARFRAMEWORK_METRICS_TOKEN`. It is separate from the ML-DSA device keys and from `ROBOT_DEVICE_TOKEN`. Configure the same random secret on the dashboard host and on the Raspberry Pi running `reciever.py`:

1. On the dashboard host, generate a token with `python -c 'import secrets; print(secrets.token_hex(32))'`. Set it as `CARFRAMEWORK_METRICS_TOKEN` before starting Uvicorn or Electron. Also set `CARFRAMEWORK_ROOT` to the CarFramework checkout if the default parent folder is not the checkout. The backend listens on `0.0.0.0:5007` by default when the token is configured.
2. On the Raspberry Pi, set `CARFRAMEWORK_METRICS_HOST` to the dashboard host's reachable Wi-Fi/LAN IP, set `CARFRAMEWORK_METRICS_TOKEN` to the same token, and set `CARFRAMEWORK_METRICS_PORT=5007`. Then run the patched `reciever.py` on the Pi.
3. Allow inbound UDP `5007` through the dashboard host's firewall on the private network. The camera sender still sends encrypted AVIF to the Pi on UDP `5005`; the Pi sends only metrics to the dashboard host on UDP `5007`.

Example environment on the dashboard host (Linux / WSL, from `avif-lab-glass-ui/`):

```bash
export CARFRAMEWORK_METRICS_TOKEN='PASTE_THE_SHARED_RANDOM_TOKEN'
export CARFRAMEWORK_ROOT="$(cd .. && pwd)"
npm start   # Electron, or: uvicorn server:app --host 0.0.0.0 --port 8000
```

Example environment on the Raspberry Pi:

```bash
export CARFRAMEWORK_METRICS_HOST='DASHBOARD_HOST_LAN_IP'
export CARFRAMEWORK_METRICS_TOKEN='PASTE_THE_SAME_SHARED_RANDOM_TOKEN'
export CARFRAMEWORK_METRICS_PORT=5007
python3 reciever.py
```

The dashboard uses receipt-time freshness, not synchronized wall clocks, so it works on an offline Wi-Fi network. It rejects invalid HMACs and duplicate sequence numbers within a receiver session. The reporter is disabled unless both host and token are configured on the Pi. If no heartbeat arrives for five seconds, the display returns to no-data rather than holding stale values as live.

**What the measurements mean:** the `Receiver decrypt + decode` value is measured around `decrypt()` plus `cv2.imdecode()` on the Pi. It is not sender-side AVIF encode latency. The incoming MB/s is calculated from encrypted UDP datagram bytes observed by `reciever.py`. FPS counts successfully decrypted and decoded frames, not packets that failed authentication or decode.

## Source and cryptographic status

The Security page reads the actual `sender.py`, `reciever.py`, and `encryption.py` files under `CARFRAMEWORK_ROOT`; it does not hard-code algorithm names, nonce sizes, ports, or sender address. It checks only whether expected local key files exist; it never reads their contents or exposes them to the browser.

The uploaded source version sets `NONCE_LEN = 192`, while AES-256-GCM-SIV requires a 12-byte nonce. The source also uses ML-KEM-768 and ML-DSA-44, with no HKDF reference. The UI therefore reports PQC as **not verified**. A receiver heartbeat or decoded frame is an observation of the running receiver, not an independent cryptographic audit.

The dashboard's browser WebSocket camera API remains a separate optional JPEG input. The CarFramework UDP receiver metrics are now gathered, but the actual encrypted AVIF frames are still shown by the receiver's OpenCV window; this metrics side-channel does not forward video frames into the browser viewer. Dashboard movement controls also remain separate from the `trackhuman.py` → UNO path.

Do not run two receivers on UDP port `5005`. The CarFramework `reciever.py` already binds that port. Aurora Glass uses TCP port `8000` and, when enabled, listens for signed metrics on UDP `5007`.

## What works in this UI package

- Aurora Glass responsive dashboard and Video Studio.
- Server-backed registration/login and authenticated browser sessions.
- Authenticated WebSocket viewer routes for a compatible WebSocket camera client.
- Robot command API with an allow-list and short command pulses.
- Local file preview and authenticated media uploads.
- Live operational metrics from the signed CarFramework UDP receiver reporter, plus dynamically inspected source configuration and key-file presence.

## What is not wired together yet

- The supplied CarFramework encrypted UDP AVIF frames are not forwarded to `/ws/camera`; only receiver measurements are forwarded to the dashboard API.
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
| `GET` | `/api/metrics` | Live receiver measurements and device telemetry |
| `GET` | `/api/security/status` | Source-inspected CarFramework configuration and runtime reporter status |
| `GET` | `/api/robot/status` | Authenticated WebSocket device status |
| `POST` | `/api/robot/command` | Send an allow-listed command to a WebSocket device |
| `POST` | `/api/video/upload` | Upload image/video |
| `GET` | `/api/video/{id}` | Download user's uploaded media |
| `WS` | `/ws/robot/camera` | Separate authenticated WebSocket device input |
| `WS` | `/ws/camera` | Authenticated browser viewer for WebSocket-fed frames |

## Project files

- `index.html`, `styles.css`, `app.js`: browser interface
- `server.py`: FastAPI application, auth/session handling, WebSocket API, HMAC-authenticated UDP metrics listener, source inspection
- `requirements.txt`: Python dependencies
- `start_windows.ps1`, `start_linux_mac.sh`: launch helpers
- `data/`: SQLite database created on first run
- `uploads/`: user-uploaded media created on first upload


## Electron desktop app

Aurora Glass can also run in a native Electron window while reusing the same HTML/CSS/JS and FastAPI backend. See [`ELECTRON.md`](ELECTRON.md) for development setup, desktop security settings, network binding, and installer builds. This is a desktop shell around the existing dashboard; it does not yet bridge CarFramework's encrypted UDP/AVIF receiver into the browser viewer.
