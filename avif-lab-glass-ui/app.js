(() => {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    user: 'Studio user', workspace: 'Personal workspace', view: 'dashboard', connected: false,
    robotStopped: false, commandCount: 0, commandHistory: [], mediaFile: null, mediaUrl: null,
    mediaKind: null, db: null, dbReady: false, codec: 'AVIF', quality: 72,
    resolution: '1280 × 720', pixel: 'Auto', metadata: true, chunks: false,
    compact: false, reduceMotion: false, network: { robotUrl: '', videoUrl: '', apiEndpoint: '' },
    cameraSocket: null, cameraFrameUrl: null, localCameraStream: null, activeCamera: null
  };
  const DEFAULTS = {
    workspace: 'Personal workspace', compact: false, reduceMotion: false,
    robotUrl: '', videoUrl: '', apiEndpoint: '', codec: 'AVIF', quality: 72,
    resolution: '1280 × 720', pixel: 'Auto', metadata: true, chunks: false
  };

  let authMode = 'login';

  async function apiRequest(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) }
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* response may be empty */ }
    if (!response.ok) throw new Error(payload.detail || payload.message || `Request failed (${response.status})`);
    return payload;
  }

  function setAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    const registering = authMode === 'register';
    $('#auth-heading').innerHTML = registering ? 'Create your <span>AVIF Lab</span>' : 'Welcome to <span>AVIF Lab</span>';
    $('#auth-copy').textContent = registering
      ? 'Create a workspace for your robot camera, video experiments, and codec tools.'
      : 'Your control room for robot camera streams, video experiments, and autonomous motion.';
    $('#auth-submit').innerHTML = `${registering ? 'Create account' : 'Sign in'} ${icon('arrow-right')}`;
    $('#auth-toggle').innerHTML = `${registering ? 'I already have an account' : 'Create a new account'} ${icon('chevron')}`;
    $('#auth-password-label').textContent = registering ? 'Create password' : 'Password';
    $('#login-pin').autocomplete = registering ? 'new-password' : 'current-password';
    $('#login-pin').minLength = registering ? 10 : 1;
    $('#login-pin').placeholder = registering ? 'At least 10 characters' : 'Enter your password';
    $('#auth-error').classList.add('hidden');
    $('#auth-error').textContent = '';
  }

  async function submitAuth(event) {
    event.preventDefault();
    const username = $('#login-name').value.trim();
    const password = $('#login-pin').value;
    const button = $('#auth-submit');
    button.disabled = true;
    button.innerHTML = `${authMode === 'register' ? 'Creating account' : 'Signing in'}…`;
    $('#auth-error').classList.add('hidden');
    try {
      const payload = await apiRequest(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', {
        method: 'POST', body: JSON.stringify({ username, password })
      });
      enterWorkspace(payload.username || username);
    } catch (error) {
      $('#auth-error').textContent = error.message || 'Could not connect to the AVIF Lab API.';
      $('#auth-error').classList.remove('hidden');
    } finally {
      button.disabled = false;
      button.innerHTML = `${authMode === 'register' ? 'Create account' : 'Sign in'} ${icon('arrow-right')}`;
    }
  }

  // Small IndexedDB key/value store for local preferences; never store secrets here.
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB not supported'));
      const request = indexedDB.open('avif-lab-browser-data', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('preferences')) db.createObjectStore('preferences', { keyPath: 'key' });
      };
      request.onsuccess = () => { state.db = request.result; state.dbReady = true; resolve(state.db); };
      request.onerror = () => reject(request.error || new Error('Database could not be opened'));
    });
  }
  async function dbGet(key) {
    if (state.dbReady && state.db) return new Promise((resolve, reject) => {
      const request = state.db.transaction('preferences', 'readonly').objectStore('preferences').get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : undefined);
      request.onerror = () => reject(request.error);
    });
    try { const raw = localStorage.getItem(`avif-lab:${key}`); return raw === null ? undefined : JSON.parse(raw); }
    catch { return undefined; }
  }
  async function dbSet(key, value) {
    if (state.dbReady && state.db) return new Promise((resolve, reject) => {
      const tx = state.db.transaction('preferences', 'readwrite');
      tx.objectStore('preferences').put({ key, value });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error || new Error('Save failed'));
    });
    localStorage.setItem(`avif-lab:${key}`, JSON.stringify(value));
  }
  async function dbClear() {
    if (state.dbReady && state.db) await new Promise((resolve, reject) => {
      const tx = state.db.transaction('preferences', 'readwrite');
      tx.objectStore('preferences').clear(); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    Object.keys(localStorage).filter(k => k.startsWith('avif-lab:')).forEach(k => localStorage.removeItem(k));
  }
  async function savePref(key, value) {
    try { await dbSet(key, value); return true; }
    catch (error) { console.warn('Local preference save failed:', error); toast('Could not save this preference. Check browser storage settings.', 'error'); return false; }
  }
  const prefKeys = Object.keys(DEFAULTS);
  async function loadPrefs() {
    for (const key of prefKeys) {
      const value = await dbGet(key);
      if (value !== undefined) state[key] = value;
    }
    state.workspace = String(state.workspace || DEFAULTS.workspace).slice(0, 48);
    state.quality = Number(state.quality) || DEFAULTS.quality;
    state.network = { robotUrl: state.robotUrl || '', videoUrl: state.videoUrl || '', apiEndpoint: state.apiEndpoint || '' };
    applyPrefsToUi();
  }

  function icon(id) { return `<svg aria-hidden="true"><use href="#i-${id}"></use></svg>`; }
  function toast(message, type = 'success') {
    const node = document.createElement('div');
    node.className = `toast ${type === 'error' ? 'error' : ''}`;
    node.innerHTML = `${icon(type === 'error' ? 'x' : 'check')}<span></span>`;
    $('.toast span', node).textContent = message;
    $('#toast-region').appendChild(node);
    window.setTimeout(() => { node.style.opacity = '0'; node.style.transform = 'translateY(6px)'; window.setTimeout(() => node.remove(), 220); }, 3300);
  }
  function setText(selector, value) { const node = $(selector); if (node) node.textContent = value; }
  function setView(view) {
    if (!$(`#view-${view}`)) return;
    state.view = view;
    $$('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`));
    $$('.nav-item[data-view]').forEach(node => node.classList.toggle('active', node.dataset.view === view));
    const label = ({ dashboard: 'Overview', video: 'Video studio', robot: 'Robot control', codec: 'Codec lab', settings: 'Settings' })[view] || 'Overview';
    setText('#breadcrumb-current', label);
    if (view === 'video' && state.mediaFile) syncMediaInfo();
    window.scrollTo({ top: 0, behavior: state.reduceMotion ? 'auto' : 'smooth' });
  }
  function enterWorkspace(name) {
    state.user = (name || 'Studio user').trim().slice(0, 40) || 'Studio user';
    const firstName = state.user.split(/[\s'’]/)[0] || 'builder';
    setText('#user-name', state.user); setText('#greeting-name', firstName); setText('#workspace-label', state.workspace || 'Personal workspace');
    setText('#user-avatar', firstName.slice(0, 1).toUpperCase()); setText('#top-avatar', firstName.slice(0, 1).toUpperCase());
    $('#login-screen').classList.add('hidden'); $('#app-shell').classList.remove('hidden');
    setView(state.view || 'dashboard');
    toast(`Workspace ready. Welcome, ${firstName}.`);
    connectRobot({ quiet: true });
  }
  async function leaveWorkspace() {
    stopLiveSources();
    try { await apiRequest('/api/auth/logout', { method: 'POST' }); } catch { /* session may already be expired */ }
    $('#app-shell').classList.add('hidden'); $('#login-screen').classList.remove('hidden');
    $('#login-pin').value = '';
    toast('Signed out of AVIF Lab.');
  }

  function applyPrefsToUi() {
    $('#setting-workspace').value = state.workspace;
    $('#workspace-label').textContent = state.workspace;
    $('#compact-toggle').checked = !!state.compact;
    $('#motion-toggle').checked = !!state.reduceMotion;
    document.body.classList.toggle('compact-mode', !!state.compact);
    document.body.classList.toggle('reduce-motion', !!state.reduceMotion);
    $('#setting-robot-url').value = state.robotUrl || '';
    $('#setting-video-url').value = state.videoUrl || '';
    $('#api-endpoint').value = state.apiEndpoint || '/api/video/upload';
    $('#quality-range').value = state.quality;
    $('#quality-number').textContent = state.quality;
    $('#resolution-setting').value = state.resolution;
    $('#pixel-setting').value = state.pixel;
    $('#metadata-toggle').checked = !!state.metadata;
    $('#chunks-toggle').checked = !!state.chunks;
    $$('.segment').forEach(button => button.classList.toggle('active', button.dataset.codec === state.codec));
    updateCodecUi();
    updateStorageStatus();
  }
  async function updateStorageStatus() {
    setText('#storage-status', state.dbReady ? 'IndexedDB available · preferences stored locally' : 'Local preference fallback available');
    $('#storage-dot').style.background = state.dbReady ? '#7ee5b9' : '#f3ba7a';
  }

  function showModal(title, copy, confirmText, onConfirm) {
    setText('#modal-title', title); setText('#modal-copy', copy); setText('#modal-confirm', confirmText);
    $('#modal-backdrop').classList.remove('hidden');
    const close = () => { $('#modal-backdrop').classList.add('hidden'); $('#modal-confirm').onclick = null; $('#modal-cancel').onclick = null; };
    $('#modal-cancel').onclick = close;
    $('#modal-confirm').onclick = async () => { close(); await onConfirm(); };
  }
  function addActivity(title, description, kind = 'purple') {
    const list = $('#activity-list');
    const empty = $('.empty-activity', list); if (empty) empty.remove();
    const row = document.createElement('div'); row.className = 'activity-row';
    const iconName = kind === 'cyan' ? 'cpu' : kind === 'orange' ? 'wifi' : kind === 'mint' ? 'check' : 'activity';
    const iconBox = document.createElement('span'); iconBox.className = `activity-icon ${kind}`; iconBox.innerHTML = icon(iconName);
    const copy = document.createElement('div'); const b = document.createElement('b'); b.textContent = title; const p = document.createElement('p'); p.textContent = description; copy.append(b, p);
    const time = document.createElement('time'); time.textContent = 'Just now'; row.append(iconBox, copy, time); list.prepend(row);
    while (list.children.length > 5) list.lastElementChild.remove();
  }

  // Media is previewed locally. This prototype deliberately does not upload files.
  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB']; let value = bytes / 1024; let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
  }
  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
    return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
  }
  function openFilePicker() { $('#media-input').click(); }
  function clearMedia() {
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaUrl = null; state.mediaFile = null; state.mediaKind = null;
    ['#video-element', '#studio-video'].forEach(sel => { const node = $(sel); node.pause?.(); node.removeAttribute('src'); node.load?.(); node.classList.add('hidden'); });
    ['#image-element', '#studio-image'].forEach(sel => { const node = $(sel); node.removeAttribute('src'); node.classList.add('hidden'); });
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.remove('hidden'));
    $('#recording-indicator').classList.add('hidden'); $('#stage-play').innerHTML = icon('play');
    setText('#video-mode-tag', 'NO SOURCE'); setText('#source-name', 'No source selected'); setText('#source-detail', 'Ready for a local file or API stream');
    setText('#stage-resolution', 'AWAITING INPUT'); setText('#stage-time', '00:00:00');
    setText('#studio-file-title', 'No media loaded'); setText('#studio-file-type', 'IDLE'); setText('#studio-source-name', 'No file selected'); setText('#studio-source-size', 'Local preview only');
    ['#detail-name', '#detail-size', '#detail-type', '#detail-resolution', '#detail-duration'].forEach(sel => setText(sel, '—'));
  }
  function loadMedia(file) {
    if (!file) return;
    stopLiveSources();
    const isImage = file.type.startsWith('image/') || /\.(avif|avifs|png|jpe?g|webp|gif)$/i.test(file.name);
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv|ogv|avi)$/i.test(file.name);
    if (!isImage && !isVideo) { toast('Choose a browser-previewable image or video file.', 'error'); return; }
    if (state.mediaUrl) URL.revokeObjectURL(state.mediaUrl);
    state.mediaFile = file; state.mediaKind = isImage ? 'image' : 'video'; state.mediaUrl = URL.createObjectURL(file);
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.add('hidden'));
    if (isImage) {
      ['#video-element', '#studio-video'].forEach(sel => $(sel).classList.add('hidden'));
      ['#image-element', '#studio-image'].forEach(sel => { const node = $(sel); node.src = state.mediaUrl; node.classList.remove('hidden'); node.onload = () => syncMediaInfo(node.naturalWidth, node.naturalHeight); node.onerror = () => toast('This image format is not supported by the current browser.', 'error'); });
      setText('#video-mode-tag', 'IMAGE PREVIEW'); setText('#studio-file-type', file.type === 'image/avif' || /\.avif$/i.test(file.name) ? 'AVIF IMAGE' : 'IMAGE'); setText('#stage-resolution', 'IMAGE INPUT');
    } else {
      ['#image-element', '#studio-image'].forEach(sel => $(sel).classList.add('hidden'));
      ['#video-element', '#studio-video'].forEach(sel => { const node = $(sel); node.src = state.mediaUrl; node.classList.remove('hidden'); node.onloadedmetadata = () => syncMediaInfo(node.videoWidth, node.videoHeight, node.duration); node.onerror = () => toast('This video format or codec is not supported by your browser.', 'error'); });
      setText('#video-mode-tag', 'LOCAL VIDEO'); setText('#studio-file-type', 'VIDEO'); setText('#stage-resolution', 'VIDEO INPUT');
    }
    setText('#source-name', file.name); setText('#source-detail', `${formatBytes(file.size)} · Local file`);
    setText('#studio-file-title', file.name); setText('#studio-source-name', file.name); setText('#studio-source-size', `${formatBytes(file.size)} · Local preview only`);
    setText('#detail-name', file.name); setText('#detail-size', formatBytes(file.size)); setText('#detail-type', file.type || 'Unknown / browser inferred');
    setText('#detail-duration', isImage ? 'Still image' : 'Reading metadata…'); setText('#detail-resolution', 'Reading metadata…');
    addActivity('Media imported', `${file.name} · ${formatBytes(file.size)}`, 'cyan');
    setView(state.view === 'dashboard' ? 'dashboard' : 'video');
    toast(`Loaded ${file.name} for local preview.`);
  }
  function syncMediaInfo(width, height, duration) {
    if (!state.mediaFile) return;
    const dims = width && height ? `${width} × ${height}` : 'Not available';
    setText('#detail-resolution', dims); setText('#stage-resolution', width && height ? `${width} × ${height}` : 'INPUT LOADED');
    if (duration !== undefined) setText('#detail-duration', formatDuration(duration));
    else if (state.mediaKind === 'image') setText('#detail-duration', 'Still image');
  }

  async function connectRobot(options = {}) {
    try {
      const data = await apiRequest('/api/robot/status');
      state.connected = !!data.connected;
      const connected = state.connected;
      const telemetry = data.telemetry || {};
      $('#connect-robot').innerHTML = `${icon('wifi')} ${connected ? 'Refresh robot status' : 'Check robot connection'}`;
      $('#robot-connect-page').innerHTML = `${icon('wifi')} Check status`;
      $('#robot-connection-tag').className = `tag ${connected ? 'tag-cyan' : 'tag-warning'}`;
      $('#robot-connection-tag').innerHTML = `<span class="tag-dot"></span> ${connected ? 'CONNECTED' : 'DISCONNECTED'}`;
      $('#robot-page-status').className = `tag ${connected ? 'tag-cyan' : 'tag-warning'}`;
      $('#robot-page-status').innerHTML = `<span class="tag-dot"></span> ${connected ? 'ROBOT ONLINE' : 'ROBOT OFFLINE'}`;
      setText('#robot-stat-badge', connected ? 'ONLINE' : 'OFFLINE'); $('#robot-stat-badge').className = `trend ${connected ? 'good' : 'warning'}`;
      setText('#robot-stat-number', telemetry.battery == null ? '-- %' : `${telemetry.battery} %`);
      setText('#robot-stat-status', connected ? 'Connected device' : 'Awaiting device');
      setText('#robot-mode', telemetry.mode || (connected ? 'Connected' : 'Standby'));
      setText('#robot-link', connected ? 'Online' : 'Offline');
      setText('#robot-battery', telemetry.battery == null ? '--' : `${telemetry.battery}%`);
      setText('#sensor-left', telemetry.sensor_left ?? '--'); setText('#sensor-right', telemetry.sensor_right ?? '--');
      setText('#left-reading', telemetry.sensor_left ?? '--'); setText('#right-reading', telemetry.sensor_right ?? '--');
      setText('#system-pill-text', connected ? 'Robot connected' : 'API online · robot offline');
      $('#quick-stop').disabled = !connected; $$('.direction-btn, #direction-stop').forEach(btn => btn.disabled = !connected);
      setText('#controller-caption', connected ? 'Connected to the authenticated robot API' : 'API is reachable; waiting for the robot device');
      setText('#sensor-summary', connected ? 'Receiving robot status. Sensor fields update when the Pi sends telemetry.' : 'No robot device is connected. Camera and sensor data will appear when the Raspberry Pi connects.');
      if (!options.quiet) toast(connected ? 'Robot API connection is active.' : 'API reached. No robot device is connected yet.', connected ? 'success' : 'error');
    } catch (error) {
      state.connected = false;
      $('#quick-stop').disabled = true; $$('.direction-btn, #direction-stop').forEach(btn => btn.disabled = true);
      setText('#system-pill-text', 'API unavailable');
      setText('#controller-caption', 'Could not reach the API. Check the server and sign-in session.');
      if (!options.quiet) toast(error.message || 'Could not reach the robot API.', 'error');
    }
  }

  function addCommand(command, description) {
    state.commandCount++;
    setText('#command-count', `${state.commandCount} EVENTS`); setText('#last-command', command); setText('#last-command-time', `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${description}`);
    const history = $('#command-history'); const empty = $('.empty-log', history); if (empty) empty.remove();
    const row = document.createElement('div'); row.className = 'command-event'; const b = document.createElement('b'); b.textContent = command; const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); row.append(b, time); history.prepend(row);
    state.commandHistory.unshift({ command, description }); while (history.children.length > 6) history.lastElementChild.remove();
  }
  async function sendCommand(command) {
    if (!state.connected) return toast('Robot is offline. No command was sent.', 'error');
    try {
      const data = await apiRequest('/api/robot/command', { method: 'POST', body: JSON.stringify({ command }) });
      const labels = { forward: 'robot.move_forward', reverse: 'robot.reverse', left: 'robot.turn_left', right: 'robot.turn_right', stop: 'robot.stop' };
      addCommand(labels[command] || 'robot.unknown', `API accepted · ${data.duration_ms ?? 0} ms pulse`);
      setText('#robot-mode', command === 'stop' ? 'Stopped' : command === 'forward' || command === 'reverse' ? 'Moving' : 'Turning');
      if (command === 'stop') state.robotStopped = true; else state.robotStopped = false;
      toast(`Robot API accepted “${command}”. Firmware watchdog still required.`);
    } catch (error) { toast(error.message || 'Robot command failed.', 'error'); await connectRobot({ quiet: true }); }
  }

  function updateCodecUi() {
    const q = Number(state.quality) || 72; state.quality = q;
    setText('#quality-number', q); setText('#score-value', q); setText('#quality-display', `${q}%`); setText('#compression-display', `${100 - q}%`);
    $('#quality-bar').style.width = `${q}%`; $('#compression-bar').style.width = `${100 - q}%`;
    const ring = $('.score-ring'); ring.style.background = `conic-gradient(from -90deg,#9c91ff 0%,#73e1d9 ${q}%,rgba(136,148,196,.1) ${q}%)`;
    setText('#score-title', q > 84 ? 'High fidelity profile' : q < 40 ? 'Small-file profile' : 'Balanced profile');
    setText('#score-copy', q > 84 ? 'Prioritizes visual quality; files may be larger.' : q < 40 ? 'Prioritizes smaller output; visible artifacts may increase.' : 'A practical middle ground between file size and visual quality.');
    setText('#summary-codec', state.codec); setText('#summary-resolution', state.resolution); setText('#summary-quality', `${q} / 100`); setText('#summary-metadata', state.metadata ? 'Preserved' : 'Discarded'); setText('#summary-chunks', state.chunks ? 'Enabled' : 'Disabled');
    const descriptions = {
      AVIF: 'AVIF is designed for efficient still-image compression. A sequence of images is not automatically a standard video stream.',
      AV1: 'AV1 is a video codec. A real pipeline needs an encoder/decoder implementation and a supported container or streaming transport.',
      Custom: 'A custom pipeline needs a defined bitstream, framing, encoder, decoder, and compatibility plan before browser playback.'
    };
    setText('#codec-description', descriptions[state.codec] || descriptions.AVIF);
  }
  function readCodecControls() {
    state.codec = $('.segment.active')?.dataset.codec || 'AVIF';
    state.quality = Number($('#quality-range').value); state.resolution = $('#resolution-setting').value; state.pixel = $('#pixel-setting').value;
    state.metadata = $('#metadata-toggle').checked; state.chunks = $('#chunks-toggle').checked; updateCodecUi();
  }
  async function saveCodec() {
    readCodecControls();
    const values = { codec: state.codec, quality: state.quality, resolution: state.resolution, pixel: state.pixel, metadata: state.metadata, chunks: state.chunks };
    let ok = true; for (const [key, value] of Object.entries(values)) ok = await savePref(key, value) && ok;
    if (ok) { setText('#codec-save-message', 'Saved locally ✓'); toast('Codec profile saved to this browser.'); addActivity('Codec profile saved', `${state.codec} · quality ${state.quality}`, 'cyan'); }
  }
  async function saveSettings() {
    state.workspace = $('#setting-workspace').value.trim().slice(0, 48) || 'Personal workspace';
    state.compact = $('#compact-toggle').checked; state.reduceMotion = $('#motion-toggle').checked;
    document.body.classList.toggle('compact-mode', state.compact); document.body.classList.toggle('reduce-motion', state.reduceMotion);
    const values = { workspace: state.workspace, compact: state.compact, reduceMotion: state.reduceMotion };
    let ok = true; for (const [key, value] of Object.entries(values)) ok = await savePref(key, value) && ok;
    setText('#workspace-label', state.workspace);
    if ($('#user-name').textContent) setText('#greeting-name', state.user.split(/[\s'’]/)[0] || 'builder');
    if (ok) { setText('#settings-save-message', 'Saved ✓'); toast('Workspace preferences saved.'); }
  }
  async function saveNetwork() {
    state.robotUrl = $('#setting-robot-url').value.trim(); state.videoUrl = $('#setting-video-url').value.trim(); state.apiEndpoint = $('#api-endpoint').value.trim();
    const values = { robotUrl: state.robotUrl, videoUrl: state.videoUrl, apiEndpoint: state.apiEndpoint };
    let ok = true; for (const [key, value] of Object.entries(values)) ok = await savePref(key, value) && ok;
    state.network = { robotUrl: state.robotUrl, videoUrl: state.videoUrl, apiEndpoint: state.apiEndpoint };
    if (ok) { setText('#network-save-message', 'Saved ✓'); setText('#transfer-status', state.apiEndpoint ? 'ENDPOINT SET' : 'NOT CONNECTED'); toast('Network settings saved. This did not contact any API.'); }
  }

  async function handleTransferTest() {
    if (!state.mediaFile) { toast('Import a media file before uploading.', 'error'); setView('video'); return; }
    const rawEndpoint = $('#api-endpoint').value.trim() || '/api/video/upload';
    let endpoint;
    try { endpoint = new URL(rawEndpoint, window.location.origin); }
    catch { toast('Enter a valid API endpoint.', 'error'); return; }
    if (endpoint.origin !== window.location.origin) { toast('For safety, media uploads are restricted to this AVIF Lab server.', 'error'); return; }
    const result = $('#transfer-result'); result.classList.remove('hidden'); result.textContent = 'Uploading media…';
    const button = $('#simulate-transfer'); button.disabled = true;
    try {
      const body = new FormData(); body.append('file', state.mediaFile, state.mediaFile.name);
      const data = await apiRequest(endpoint.pathname + endpoint.search, { method: 'POST', body });
      result.textContent = `UPLOADED · ${data.filename} · ${formatBytes(data.size_bytes)} · ID ${data.id}`;
      setText('#transfer-status', 'UPLOAD COMPLETE'); addActivity('Media uploaded', `${data.filename} · ${formatBytes(data.size_bytes)}`, 'cyan');
      toast('Media uploaded to the authenticated AVIF Lab API.');
    } catch (error) {
      result.textContent = `UPLOAD FAILED · ${error.message}`;
      setText('#transfer-status', 'UPLOAD FAILED'); toast(error.message || 'Upload failed.', 'error');
    } finally { button.disabled = false; }
  }

  async function updateRobotStop() {
    if (!state.connected) return toast('Robot is offline. Use the physical emergency stop if needed.', 'error');
    await sendCommand('stop');
    setText('#robot-mode', 'Stop requested');
    toast('Stop command requested. A physical kill switch is still essential.', 'error');
  }

  function hideStageSources() {
    ['#video-element', '#studio-video'].forEach(sel => { const node = $(sel); node.pause?.(); node.removeAttribute('src'); node.load?.(); node.classList.add('hidden'); });
    ['#image-element', '#studio-image', '#robot-camera-element', '#studio-robot-camera'].forEach(sel => { const node = $(sel); node.classList.add('hidden'); });
    ['#laptop-camera-element', '#studio-laptop-camera'].forEach(sel => { const node = $(sel); node.classList.add('hidden'); });
  }

  function setCameraControls(mode) {
    const robot = mode === 'robot'; const laptop = mode === 'laptop';
    ['#camera-stop-top', '#dashboard-camera-stop'].forEach(sel => $(sel).classList.toggle('hidden', !robot));
    ['#local-camera-stop-top', '#local-camera-stop-studio', '#dashboard-local-camera-stop'].forEach(sel => $(sel).classList.toggle('hidden', !laptop));
    ['#camera-start-top', '#dashboard-camera', '#studio-camera'].forEach(sel => $(sel).classList.toggle('hidden', robot));
    ['#local-camera-start-top', '#dashboard-local-camera', '#studio-local-camera'].forEach(sel => $(sel).classList.toggle('hidden', laptop));
  }

  function setCameraSourceText(name, detail, modeTag) {
    setText('#source-name', name); setText('#source-detail', detail); setText('#video-mode-tag', modeTag);
    setText('#studio-source-name', name); setText('#studio-source-size', detail); setText('#studio-file-title', name); setText('#studio-file-type', modeTag);
  }

  function displayRobotFrame(blob) {
    const nextUrl = URL.createObjectURL(blob);
    const previousUrl = state.cameraFrameUrl; state.cameraFrameUrl = nextUrl;
    ['#robot-camera-element', '#studio-robot-camera'].forEach(sel => { const img = $(sel); img.src = nextUrl; img.classList.remove('hidden'); });
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.add('hidden'));
    ['#video-element', '#studio-video', '#image-element', '#studio-image', '#laptop-camera-element', '#studio-laptop-camera'].forEach(sel => $(sel).classList.add('hidden'));
    $('#recording-indicator').classList.remove('hidden');
    setText('#stage-resolution', 'ROBOT CAMERA · JPEG');
    setCameraSourceText('Raspberry Pi camera', 'Live JPEG frames · authenticated WebSocket', 'ROBOT LIVE');
    if (previousUrl) window.setTimeout(() => URL.revokeObjectURL(previousUrl), 1200);
  }

  function connectRobotCamera() {
    if (state.cameraSocket && state.cameraSocket.readyState <= WebSocket.OPEN) return toast('Robot camera viewer is already connecting or streaming.');
    stopLiveSources(); clearMedia();
    hideStageSources();
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.add('hidden'));
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws/camera`);
    state.cameraSocket = socket; state.activeCamera = 'robot';
    socket.binaryType = 'blob';
    setCameraControls('robot');
    setCameraSourceText('Connecting to robot camera…', 'Waiting for authenticated robot stream', 'CONNECTING');
    socket.onopen = () => { if (state.cameraSocket === socket) toast('Camera viewer connected. Waiting for the Raspberry Pi frames.'); };
    socket.onmessage = event => {
      if (state.cameraSocket !== socket) return;
      if (typeof event.data === 'string') {
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'error') { toast(data.message || 'Camera viewer authentication failed.', 'error'); socket.close(); return; }
        if (data.type === 'robot_status') {
          state.connected = !!data.connected;
          setText('#system-pill-text', data.connected ? (data.camera_ready ? 'Robot video live' : 'Robot connected · waiting for frame') : 'API online · robot offline');
          connectRobot({ quiet: true });
          if (data.camera_ready) setText('#video-mode-tag', 'ROBOT LIVE');
        } else if (data.type === 'telemetry') {
          const t = data.data || {};
          if (t.sensor_left !== undefined) { setText('#sensor-left', t.sensor_left); setText('#left-reading', t.sensor_left); }
          if (t.sensor_right !== undefined) { setText('#sensor-right', t.sensor_right); setText('#right-reading', t.sensor_right); }
          if (t.battery !== undefined) { setText('#robot-battery', `${t.battery}%`); setText('#robot-stat-number', `${t.battery} %`); }
          if (t.mode !== undefined) setText('#robot-mode', t.mode);
          setText('#sensor-summary', t.line_detected === undefined ? 'Live telemetry received from the robot.' : (t.line_detected ? 'Line detected by the robot sensors.' : 'No line detected by the robot sensors.'));
        }
      } else if (event.data instanceof Blob) displayRobotFrame(event.data);
    };
    socket.onerror = () => { if (state.cameraSocket === socket) toast('Could not connect to the robot camera. Check sign-in and the API server.', 'error'); };
    socket.onclose = () => {
      if (state.cameraSocket !== socket) return;
      state.cameraSocket = null; state.activeCamera = null; setCameraControls('');
      ['#robot-camera-element', '#studio-robot-camera'].forEach(sel => $(sel).classList.add('hidden'));
      ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.remove('hidden'));
      $('#recording-indicator').classList.add('hidden');
      setCameraSourceText('No source selected', 'Robot camera API · waiting for stream', 'NO SOURCE');
    };
  }

  function stopRobotCamera() {
    const socket = state.cameraSocket; state.cameraSocket = null; state.activeCamera = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    ['#robot-camera-element', '#studio-robot-camera'].forEach(sel => { const img = $(sel); img.removeAttribute('src'); img.classList.add('hidden'); });
    if (state.cameraFrameUrl) { URL.revokeObjectURL(state.cameraFrameUrl); state.cameraFrameUrl = null; }
    $('#recording-indicator').classList.add('hidden');
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => sel && $(sel).classList.remove('hidden'));
    setCameraControls(''); setCameraSourceText('No source selected', 'Ready for a local file or API stream', 'NO SOURCE');
  }

  async function startLocalCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return toast('Camera access requires HTTPS or localhost in a supported browser.', 'error');
    stopLiveSources(); clearMedia(); hideStageSources();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      state.localCameraStream = stream; state.activeCamera = 'laptop';
      ['#laptop-camera-element', '#studio-laptop-camera'].forEach(sel => { const video = $(sel); video.srcObject = stream; video.classList.remove('hidden'); video.play().catch(() => {}); });
      ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.add('hidden'));
      $('#recording-indicator').classList.add('hidden'); setCameraControls('laptop');
      setCameraSourceText('Laptop webcam', 'Local browser stream · not sent to the server', 'LOCAL CAMERA');
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => { if (state.activeCamera === 'laptop') stopLocalCamera(); });
      toast('Laptop webcam connected locally.');
    } catch (error) {
      state.activeCamera = null; setCameraControls('');
      ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.remove('hidden'));
      toast(error.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in Chrome.' : (error.message || 'Could not open the laptop webcam.'), 'error');
    }
  }

  function stopLocalCamera() {
    if (state.localCameraStream) state.localCameraStream.getTracks().forEach(track => track.stop());
    state.localCameraStream = null;
    ['#laptop-camera-element', '#studio-laptop-camera'].forEach(sel => { const video = $(sel); video.pause?.(); video.srcObject = null; video.classList.add('hidden'); });
    if (state.activeCamera === 'laptop') state.activeCamera = null;
    setCameraControls('');
    if (!state.mediaFile) ['#video-placeholder', '#studio-placeholder'].forEach(sel => $(sel).classList.remove('hidden'));
  }

  function stopLiveSources() {
    stopRobotCamera(); stopLocalCamera();
  }

  // Event wiring
  $$('.nav-item[data-view], [data-view]').forEach(button => button.addEventListener('click', () => setView(button.dataset.view)));
  $('#login-form').addEventListener('submit', submitAuth);
  $('#auth-toggle').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'register' : 'login'));
  $('#reveal-pin').addEventListener('click', () => { const input = $('#login-pin'); input.type = input.type === 'password' ? 'text' : 'password'; $('#reveal-pin').textContent = input.type === 'password' ? 'Show' : 'Hide'; });
  $('#logout-btn').addEventListener('click', leaveWorkspace);
  $('#quick-upload').addEventListener('click', openFilePicker); $('#stage-upload').addEventListener('click', openFilePicker); $('#studio-choose').addEventListener('click', openFilePicker); $('#video-import-top').addEventListener('click', openFilePicker);
  $('#media-input').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) loadMedia(file); event.target.value = ''; });
  $('#open-video').addEventListener('click', () => setView('video')); $('#clear-media').addEventListener('click', () => { clearMedia(); toast('Media cleared from the preview.'); });
  $('#stage-play').addEventListener('click', () => {
    if (!state.mediaFile) return openFilePicker();
    const video = state.view === 'video' ? $('#studio-video') : $('#video-element');
    if (state.mediaKind !== 'video') return toast('Still images do not have playback controls.');
    if (video.paused) { video.play().catch(() => toast('Your browser could not play this media.', 'error')); $('#stage-play').innerHTML = icon('pause'); }
    else { video.pause(); $('#stage-play').innerHTML = icon('play'); }
  });
  $$('#video-element, #studio-video').forEach(video => video.addEventListener('ended', () => { $('#stage-play').innerHTML = icon('play'); }));
  $('#simulate-transfer').addEventListener('click', handleTransferTest);
  ['#camera-start-top', '#dashboard-camera', '#studio-camera'].forEach(sel => $(sel).addEventListener('click', connectRobotCamera));
  ['#camera-stop-top', '#dashboard-camera-stop'].forEach(sel => $(sel).addEventListener('click', stopRobotCamera));
  ['#local-camera-start-top', '#dashboard-local-camera', '#studio-local-camera'].forEach(sel => $(sel).addEventListener('click', startLocalCamera));
  ['#local-camera-stop-top', '#local-camera-stop-studio', '#dashboard-local-camera-stop'].forEach(sel => $(sel).addEventListener('click', stopLocalCamera));
  $('#connect-robot').addEventListener('click', connectRobot); $('#robot-connect-page').addEventListener('click', connectRobot); $('#quick-stop').addEventListener('click', updateRobotStop); $('#direction-stop').addEventListener('click', () => sendCommand('stop'));
  $$('.direction-btn[data-command]').forEach(button => button.addEventListener('click', () => sendCommand(button.dataset.command)));
  $('#quality-range').addEventListener('input', () => { state.quality = Number($('#quality-range').value); updateCodecUi(); });
  $$('.segment').forEach(button => button.addEventListener('click', () => { $$('.segment').forEach(item => item.classList.toggle('active', item === button)); state.codec = button.dataset.codec; updateCodecUi(); }));
  ['#resolution-setting', '#pixel-setting', '#metadata-toggle', '#chunks-toggle'].forEach(sel => $(sel).addEventListener('change', readCodecControls));
  $('#save-codec').addEventListener('click', saveCodec);
  $('#reset-codec').addEventListener('click', () => { state.codec = DEFAULTS.codec; state.quality = DEFAULTS.quality; state.resolution = DEFAULTS.resolution; state.pixel = DEFAULTS.pixel; state.metadata = DEFAULTS.metadata; state.chunks = DEFAULTS.chunks; applyPrefsToUi(); toast('Codec controls reset. Save profile to persist changes.'); });
  $('#save-settings').addEventListener('click', saveSettings); $('#save-network').addEventListener('click', saveNetwork);
  $('#clear-local-data').addEventListener('click', () => showModal('Clear local preferences?', 'This removes AVIF Lab preferences stored in this browser. It will not delete your files, but saved display and codec settings will reset.', 'Clear data', async () => {
    try { await dbClear(); Object.assign(state, DEFAULTS); applyPrefsToUi(); setText('#settings-save-message', ''); setText('#network-save-message', ''); setText('#codec-save-message', ''); toast('Local preferences cleared.'); }
    catch { toast('Could not clear browser preferences.', 'error'); }
  }));
  $('#clear-activity').addEventListener('click', () => { $('#activity-list').replaceChildren(); const empty = document.createElement('div'); empty.className = 'empty-log empty-activity'; empty.textContent = 'Activity log is clear.'; $('#activity-list').appendChild(empty); toast('Activity log cleared.'); });
  $('#search-toggle').addEventListener('click', () => { $('#search-strip').classList.toggle('hidden'); if (!$('#search-strip').classList.contains('hidden')) $('#global-search').focus(); });
  $('#global-search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('#search-strip').classList.add('hidden'); event.target.value = ''; }
    if (event.key === 'Enter') {
      const query = event.target.value.trim().toLowerCase();
      const map = [['dashboard', ['overview', 'dashboard', 'home']], ['video', ['video', 'media', 'stream', 'upload']], ['robot', ['robot', 'control', 'sensor', 'line']], ['codec', ['codec', 'avif', 'av1', 'quality', 'encode']], ['settings', ['settings', 'network', 'preferences', 'api']]];
      const match = map.find(([, words]) => words.some(word => query.includes(word)));
      if (match) { setView(match[0]); $('#search-strip').classList.add('hidden'); toast(`Opened ${match[0]}.`); }
      else toast('No matching dashboard section. Try video, robot, codec, or settings.', 'error');
    }
  });
  $('#global-search').addEventListener('input', () => {});
  window.addEventListener('keydown', event => { if (event.key === 'Escape') $('#search-strip').classList.add('hidden'); });

  // Boot: IndexedDB first, localStorage fallback if browser restrictions prevent opening it.
  (async function init() {
    try { await openDb(); } catch (error) { console.warn('IndexedDB unavailable; using localStorage fallback.', error); }
    await loadPrefs();
    updateCodecUi();
    setAuthMode('login');
    try {
      const data = await apiRequest('/api/auth/me');
      if (data.username) enterWorkspace(data.username);
    } catch { /* no valid login cookie yet; show the sign-in screen */ }
  })();
})();
