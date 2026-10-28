# AVIF Lab · Aurora Glass Studio (0.4.0)

A redesigned, responsive glassmorphism workspace for a video-codec experiment and a line-following robot. It combines a FastAPI backend, server-side registration/login, Raspberry Pi camera WebSocket streaming, a local laptop-webcam preview, authenticated robot commands, and real authenticated media uploads. The interface uses translucent glass for navigation and floating controls while keeping data panels more opaque for legibility.


## Design system notes

The redesign uses an **Aurora Glass** direction: a quiet ink/navy base, violet-to-cyan light accents, generous spacing, strong title hierarchy, and legible telemetry. Glass blur is intentionally concentrated on the navigation and floating controls instead of applied to every information panel; the latter use darker, more opaque surfaces so text and live video remain easy to read.

This is informed by:

- [Apple Human Interface Guidelines — Materials](https://developer.apple.com/design/human-interface-guidelines/materials), which recommends using glass as a functional layer and applying it sparingly where it clarifies hierarchy.
- [Linear — Behind the latest design refresh](https://linear.app/now/behind-the-latest-design-refresh), which prioritizes the user's main task and lowers the visual weight of supporting navigation in a dense product.
- [Michelin Design System — Principles of a dashboard](https://designsystem.michelin.com/data-visualization/design-guidelines/principles-of-a-dashboard), which recommends predictable layout, restrained color use, and legible contrast for data.

The result is a design direction, not a claim that one visual style is objectively best for every user or screen.

## Architecture

```text
Raspberry Pi + CSI camera (or ESP32-CAM alternative)
  └─ WebSocket: /ws/robot/camera
       ├─ first text message authenticates the device token
       ├─ binary messages carry individual JPEG frames
       ├─ text messages can carry sensor telemetry
       └─ server-to-device text messages carry short movement commands

FastAPI server (same origin as dashboard)
  ├─ /api/auth/*             register, login, logout, current user
  ├─ /api/robot/status       current device/camera status
  ├─ /api/robot/command      allow-listed, short commands
  ├─ /api/video/upload       authenticated file upload (200 MB prototype cap)
  ├─ /api/video/{id}         authenticated download of user's own upload
  └─ /ws/camera              authenticated browser viewer; receives JPEG frames

Browser
  ├─ IndexedDB: harmless display preferences / codec settings only
  ├─ getUserMedia: optional laptop webcam preview, local to the browser
  └─ HttpOnly session cookie: backend authentication (not accessible to JavaScript)
```

The API receives **JPEG frames**, not an AVIF/AV1 bitstream. That keeps camera transport simple while you build your codec. Later, you can encode frames with AVIF/AV1 in a separate worker/service or replace this small JPEG-frame protocol with WebRTC for lower-latency, higher-frame-rate streaming.

The **Laptop webcam** buttons use the browser `getUserMedia()` API and keep that stream inside the browser. They do not upload it. The **Robot camera** buttons connect to `/ws/camera`, which requires a valid server login cookie and relays frames from the Raspberry Pi.

## Run on Windows

Use a recent Python 3.11+ installation. Open PowerShell in this project folder. The UI and API bundle version is 0.4.0.

1. Generate a device token and keep it private:

   ```powershell
   $env:ROBOT_DEVICE_TOKEN = (py -c "import secrets; print(secrets.token_urlsafe(32))")
   Write-Host "Copy this token into the Raspberry Pi client environment or ESP32-CAM example: $env:ROBOT_DEVICE_TOKEN"
   $env:AVIF_COOKIE_SECURE = "0"
   .\start_windows.ps1
   ```

   The token must be the same in the API environment and the robot sketch. Keep `AVIF_COOKIE_SECURE=0` for local development over HTTP on a trusted LAN only. For HTTPS, use `AVIF_COOKIE_SECURE=1`.

2. Open <http://localhost:8000>.
3. Choose **Create a new account**. Use a unique username and a password of at least 10 characters. The page now calls the backend registration/login endpoints; it does not use browser-only demo authentication.
4. Account records are stored in `data/avif_lab.sqlite3`. The backend stores a random-salt **scrypt password hash**, never the plaintext password. Session IDs are random and stored as hashes; the browser gets an `HttpOnly`, `SameSite=Strict` cookie.
5. Optional API docs: <http://localhost:8000/api/docs>.

Preferences such as display settings remain in IndexedDB. They are not an authentication store.

## Robot camera setup

### Raspberry Pi + Raspberry Pi Camera (recommended for your hardware)

This option is for a CSI ribbon camera connected to a Raspberry Pi mounted on the robot. The Pi captures JPEG frames with **Picamera2** and sends them over Wi-Fi to the AVIF Lab WebSocket API. Raspberry Pi OS Bookworm and newer use the `rpicam-*` camera tools; Picamera2 is the supported Python camera API. See the [official Raspberry Pi camera documentation](https://www.raspberrypi.com/documentation/computers/camera_software.html).

1. On the Raspberry Pi, check that the camera is detected:

   ```bash
   rpicam-hello --list-cameras
   ```

   If no camera is listed, turn the Pi off and check that the ribbon cable is fully inserted into the **CSI** connector with the contacts facing the correct direction.

2. Install the OS packages (use `apt`, not a random `pip install` for Picamera2):

   ```bash
   sudo apt update
   sudo apt install -y python3-picamera2 python3-websockets
   ```

3. Reuse the `ROBOT_DEVICE_TOKEN` printed by the **Windows server startup steps above**. Do not generate another token while the server is running, because that would make the Pi's device authentication fail. The token configured on the Pi must exactly match the token in the server process.

4. Find the Windows PC's LAN IPv4 address with `ipconfig` (for example, `192.168.1.50`). Both devices must be on the same trusted Wi-Fi/LAN. On the Pi, set the URL to that **PC address**, not `localhost`:

   ```bash
   export AVIF_WS_URL="ws://192.168.1.50:8000/ws/robot/camera"
   export ROBOT_DEVICE_TOKEN="PASTE_THE_SERVER_TOKEN_HERE"
   python3 examples/raspberry_pi_camera_client.py
   ```

   If you copied the project to the Pi, run the script from the project directory. Start with the default 640×480 at up to 8 FPS. You can adjust it with `AVIF_CAMERA_WIDTH`, `AVIF_CAMERA_HEIGHT`, `AVIF_CAMERA_FPS`, and `AVIF_CAMERA_QUALITY`.

5. Sign in to AVIF Lab on the PC, open **Video Studio**, and click **Connect robot camera**. The feed should appear when the Pi authenticates and begins sending frames. The dashboard renders JPEG frames; the AVIF/AV1 codec pipeline is a separate next step.

The example receives dashboard commands but its motor functions are deliberately placeholders. It does **not** drive real GPIO pins until you integrate your motor driver. Your line-following loop can continue to run on the Pi separately; if manual controls are added, ensure they cannot unexpectedly override autonomous safety behaviour.

### ESP32-CAM alternative

The optional `examples/esp32cam_robot_ws.ino` is for an **AI Thinker ESP32-CAM** board specifically. It requires the ESP32 Arduino board package, the `WebSockets` library by Links2004, and `ArduinoJson`. Configure `API_HOST`, `WIFI_SSID`, `WIFI_PASSWORD`, and `DEVICE_TOKEN` in that sketch, then flash it. It is not used when you have a Raspberry Pi Camera connected to a Raspberry Pi.

### Shared WebSocket protocol

Both device clients use `/ws/robot/camera` and the same protocol. The first text message authenticates the device token:

```json
{"type":"auth","token":"same-token-as-ROBOT_DEVICE_TOKEN"}
```

The server responds with `{"type":"auth","ok":true}`. Binary messages contain complete JPEG frames (SOI `FF D8`, EOI `FF D9`, maximum 1.5 MB). The robot may send sensor telemetry as JSON text, for example:

```json
{"type":"telemetry","data":{"sensor_left":0.82,"sensor_right":0.76,"battery":86,"mode":"line-follow","line_detected":true}}
```

Those values are only an example schema. Send values from your real sensors, not sample values. If you implement telemetry on the Pi client, send it through the same WebSocket as text JSON.

## Robot commands and safety

The dashboard sends one of five allow-listed commands: `forward`, `reverse`, `left`, `right`, or `stop`. The API caps the starter firmware payload to speed `0.22` and a `300 ms` pulse for directional commands. The Raspberry Pi client and ESP32 sample have **stub** motor functions; neither drives real motors until you implement `apply_motor_command()` / `stop_motors()` or `applyMotorCommand()` / `stopMotors()` for your motor driver.

Keep a hardware-side watchdog in firmware that stops the motors when the pulse expires or Wi-Fi disconnects. Add a physical kill switch and test with the wheels lifted. Do not rely on the browser or network for the only emergency stop. The dashboard's stop button can send a stop command only when the robot is connected, but cannot guarantee a disconnected robot has stopped.

## Security notes

- Passwords are **hashed**, not reversibly encrypted. This is the appropriate design for passwords: the server verifies a candidate password against a salted scrypt hash.
- Account/session records use SQLite on the server because browser-only storage cannot securely authenticate users across devices. The user's non-secret preferences still use IndexedDB.
- The session cookie is `HttpOnly` and `SameSite=Strict`; set `AVIF_COOKIE_SECURE=1` when the site is served over HTTPS.
- The WebSocket device token protects robot connections. Rotate it if exposed. This starter does not include rate limiting, multi-user roles, an admin interface, or production deployment hardening.
- The local example uses `ws://`/HTTP and is intended only for a trusted private LAN. Use TLS (`https://` and `wss://`) before using credentials or device commands on an untrusted network.
- Do not store passwords, API tokens, or secrets in localStorage or IndexedDB.

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/auth/register` | Create account and session |
| `POST` | `/api/auth/login` | Validate credentials and issue session |
| `POST` | `/api/auth/logout` | Revoke current session |
| `GET` | `/api/auth/me` | Current signed-in username |
| `GET` | `/api/health` | Basic health / robot-token configuration status |
| `GET` | `/api/robot/status` | Authenticated robot connection and telemetry status |
| `POST` | `/api/robot/command` | Send one allow-listed command |
| `POST` | `/api/video/upload` | Upload a selected image or video file |
| `GET` | `/api/video/{id}` | Download the current user's stored upload |
| `WS` | `/ws/robot/camera` | Robot authentication, JPEG frames, telemetry, commands |
| `WS` | `/ws/camera` | Authenticated browser camera viewer |

## Project files

- `index.html`, `styles.css`, `app.js`: browser interface and responsive visual system
- `server.py`: FastAPI backend and password/session logic
- `requirements.txt`: Python dependencies
- `start_windows.ps1`: Windows setup and server launcher
- `requirements.txt`: Python dependencies
- `examples/raspberry_pi_camera_client.py`: Picamera2 JPEG sender for a Raspberry Pi Camera
- `examples/esp32cam_robot_ws.ino`: optional ESP32-CAM transport example and command protocol
- `data/`: server database, created on first run
- `uploads/`: uploaded media, created on first upload
