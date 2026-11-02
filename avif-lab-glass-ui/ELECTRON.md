# Aurora Glass Desktop (Electron)

This folder turns the existing Aurora Glass web dashboard into a native desktop window. It **reuses** `index.html`, `styles.css`, `app.js`, and the existing FastAPI `server.py`; it does not rewrite the UI in React or duplicate its business logic.

Electron starts the local FastAPI process, waits for `/api/health`, then opens the dashboard in a hardened Chromium window. The Python backend is stopped when the desktop app exits.

## Requirements

- Node.js 22.12 or newer and npm.
- Python 3.11 or newer.
- The Python packages in the sibling `requirements.txt`.

## Run from the project directory

From `avif-lab-glass-ui/`:

### Linux / WSL

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
npm start
```

### Windows PowerShell

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
npm install
npm start
```

The Electron main process automatically uses the `.venv` interpreter when it exists. To use a different Python installation, set `AVIF_PYTHON` to its executable path before launching Electron.

## Build installers

Run the build command on the operating system you are targeting:

```bash
npm run dist:linux   # AppImage and .deb, on Linux
npm run dist:win     # NSIS installer, on Windows
npm run dist:mac     # .dmg, on macOS
```

Artifacts are written to `dist/`. Cross-platform builds may need platform-specific tooling and signing configuration. macOS distribution also requires signing/notarization for a normal Gatekeeper-friendly release.

## Network behaviour

- The desktop window opens `http://127.0.0.1:8000`.
- The backend defaults to binding `0.0.0.0:8000`, preserving the existing web app's LAN-device connectivity. A robot/device client can connect to this computer's LAN IP and port `8000` when it uses the dashboard's existing WebSocket protocol and device token.
- Use `AVIF_DESKTOP_BIND=127.0.0.1` to make the backend local-only.
- Use `AVIF_DESKTOP_PORT=8001` to choose another fixed port if 8000 is already occupied. The device client must use that same port.
- `ROBOT_DEVICE_TOKEN` is read from the environment. It remains separate from CarFramework's ML-KEM/ML-DSA identity keys.
- For real CarFramework receiver measurements, set `CARFRAMEWORK_METRICS_TOKEN` to the same random secret configured on the Raspberry Pi, and set `CARFRAMEWORK_ROOT` to the checkout path if it is not the UI folder's parent. The desktop backend then listens for HMAC-authenticated UDP reports on port `5007`.
- The app does not require internet after dependencies are installed. Google Fonts were removed from the front-end HTML; system font fallbacks are used offline.

**Important protocol limitation:** the patched CarFramework `reciever.py` reports real counters and timing measurements to the desktop backend on UDP `5007`, but it does not forward image frames into the browser viewer. CarFramework's encrypted AVIF frame path remains on UDP `5005`; the browser WebSocket viewer is a separate JPEG path. The source-level nonce incompatibility documented in the main README remains unchanged.

## Data storage

SQLite data and uploaded media are stored under Electron's per-user application-data directory, not inside the installation directory. This is important for installed apps, where program files may be read-only. In development mode, data is still placed in the OS-specific Electron user-data directory.

## Security choices

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- Web security remains enabled; insecure content is not allowed.
- The renderer receives no Node.js APIs. The preload exposes only a read-only `window.auroraDesktop` marker.
- New windows are blocked; external HTTPS links open in the system browser.
- Only media permission from the local dashboard origin is allowed for the existing webcam preview.
- The backend binds on the LAN by default for device compatibility. Use a trusted network, configure `ROBOT_DEVICE_TOKEN`, and set `AVIF_DESKTOP_BIND=127.0.0.1` when LAN device connections are not needed.

## Troubleshooting

- **Python backend failed:** activate `.venv`, run `python -m pip install -r requirements.txt`, then relaunch.
- **Port 8000 is busy:** stop the other dashboard server or set `AVIF_DESKTOP_PORT` to a free port before `npm start`.
- **Robot cannot connect:** ensure it uses the computer's LAN IP, the configured port, the dashboard WebSocket path, and the same `ROBOT_DEVICE_TOKEN`. The CarFramework UDP/AVIF sender is a separate protocol and is not wired to this dashboard viewer yet.
