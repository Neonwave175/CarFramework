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
    cameraSocket: null, cameraFrameUrl: null, localCameraStream: null, activeCamera: null,
    metricsTimer: null, lastObservedState: null
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
    const label = ({ dashboard: 'Overview', video: 'Video studio', robot: 'Robot control', codec: 'Codec lab', security: 'Post-quantum security', settings: 'Settings' })[view] || 'Overview';
    setText('#breadcrumb-current', label);
    if (view === 'video' && state.mediaFile) syncMediaInfo();
    if (view === 'security') refreshSecurityStatus({ quiet: true });
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
    addActivity('Signed in', `Authenticated session opened for ${state.user}.`, 'mint');
    connectRobot({ quiet: true });
    startMetricsPolling();
  }
  async function leaveWorkspace() {
    stopMetricsPolling();
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
    const time = document.createElement('time'); time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); row.append(iconBox, copy, time); list.prepend(row);
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

  function renderRobotState(connected, telemetry = {}) {
    state.connected = !!connected;
    const online = state.connected;
    $('#connect-robot').innerHTML = `${icon('wifi')} ${online ? 'Refresh robot status' : 'Check robot connection'}`;
    $('#robot-connect-page').innerHTML = `${icon('wifi')} Check status`;
    $('#robot-connection-tag').className = `tag ${online ? 'tag-cyan' : 'tag-warning'}`;
    $('#robot-connection-tag').innerHTML = `<span class="tag-dot"></span> ${online ? 'CONNECTED' : 'DISCONNECTED'}`;
    $('#robot-page-status').className = `tag ${online ? 'tag-cyan' : 'tag-warning'}`;
    $('#robot-page-status').innerHTML = `<span class="tag-dot"></span> ${online ? 'ROBOT ONLINE' : 'ROBOT OFFLINE'}`;
    setText('#robot-stat-badge', online ? 'CONTROL ONLINE' : 'CONTROL OFFLINE');
    $('#robot-stat-badge').className = `trend ${online ? 'good' : 'warning'}`;

    const battery = typeof telemetry.battery === 'number' && Number.isFinite(telemetry.battery) ? Math.max(0, Math.min(100, telemetry.battery)) : null;
    setText('#robot-stat-number', battery == null ? '— %' : `${battery.toFixed(0)} %`);
    setText('#robot-stat-status', online ? (battery == null ? 'Connected · battery not reported' : 'Live battery telemetry') : 'No control telemetry');
    setText('#robot-mode', typeof telemetry.mode === 'string' ? telemetry.mode : (online ? 'Connected · mode not reported' : 'Not reported'));
    setText('#robot-link', online ? 'Control online' : 'Control offline');
    setText('#robot-battery', battery == null ? '—' : `${battery.toFixed(0)}%`);
    setText('#sensor-left', telemetry.sensor_left ?? '—'); setText('#sensor-right', telemetry.sensor_right ?? '—');
    setText('#left-reading', telemetry.sensor_left ?? '—'); setText('#right-reading', telemetry.sensor_right ?? '—');
    if (Number.isFinite(telemetry.position_x) && Number.isFinite(telemetry.position_y)) {
      setText('#robot-position', `X ${telemetry.position_x.toFixed(1)} · Y ${telemetry.position_y.toFixed(1)}`);
    } else {
      setText('#robot-position', 'POSITION NOT REPORTED');
    }
    const batterySegments = $$('#battery-visual span');
    batterySegments.forEach((segment, index) => segment.classList.toggle('is-filled', battery != null && (index + 1) * 10 <= battery));
    $('#quick-stop').disabled = !online;
    $$('.direction-btn, #direction-stop').forEach(btn => btn.disabled = !online);
    setText('#controller-caption', online ? 'Authenticated control device connected' : 'No authenticated control device connected');
    const hasSensorReading = telemetry.sensor_left != null || telemetry.sensor_right != null;
    $('#left-node').classList.toggle('has-reading', telemetry.sensor_left != null);
    $('#right-node').classList.toggle('has-reading', telemetry.sensor_right != null);
    $('#sensor-line-display').classList.toggle('hidden', typeof telemetry.line_detected !== 'boolean' || telemetry.line_detected !== true);
    setText('#sensor-line-state', telemetry.line_detected === true ? 'Device reports: line detected' : telemetry.line_detected === false ? 'Device reports: no line detected' : 'Line state not reported');
    if (!online) setText('#sensor-summary', 'No live robot telemetry. Sensor readings appear only when the control device reports them.');
    else if (hasSensorReading || typeof telemetry.line_detected === 'boolean') setText('#sensor-summary', 'Sensor values shown here were received from the authenticated control device.');
    else setText('#sensor-summary', 'Control device connected; sensor readings have not been reported.');
  }

  async function connectRobot(options = {}) {
    try {
      const data = await apiRequest('/api/robot/status');
      const wasConnected = state.connected;
      renderRobotState(!!data.connected, data.telemetry || {});
      if (!options.quiet) toast(data.connected ? 'Authenticated robot control connection is active.' : 'API is reachable; no control device is connected.', data.connected ? 'success' : 'error');
      if (!options.quiet && wasConnected !== !!data.connected) addActivity(data.connected ? 'Robot control connected' : 'Robot control disconnected', 'State read from the authenticated device API.', data.connected ? 'mint' : 'orange');
    } catch (error) {
      renderRobotState(false, {});
      setText('#system-pill-text', 'API unavailable');
      setText('#controller-caption', 'Could not reach the API. Check the server and sign-in session.');
      if (!options.quiet) toast(error.message || 'Could not reach the robot API.', 'error');
    }
  }

  function formatMetric(value, digits = 1) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  function renderOperationalMetrics(data) {
    const video = data.video || {};
    const robot = data.robot || {};
    const receiverConnected = video.receiver_connected === true;
    const videoLive = video.live === true;
    const stateLabel = videoLive ? 'LIVE' : receiverConnected ? 'LISTENING' : 'NO DATA';
    const stateClass = videoLive ? 'good' : receiverConnected ? 'neutral' : 'warning';
    setText('#frames-stat-state', stateLabel);
    $('#frames-stat-state').className = `trend ${stateClass}`;
    $('#frames-stat').innerHTML = `${formatMetric(video.frames_per_second)} <small>fps</small>`;
    setText('#frames-stat-total', video.frames_total == null ? '— frames' : `${Number(video.frames_total).toLocaleString()} frames`);

    const sourceNames = {
      carframework_udp_receiver: 'CarFramework UDP / AVIF',
      dashboard_websocket_jpeg: 'Dashboard WebSocket / JPEG'
    };
    const sourceName = sourceNames[video.source] || 'No receiver data';
    const lastFrameAge = typeof video.last_frame_age_seconds === 'number' ? `${video.last_frame_age_seconds.toFixed(1)}s ago` : 'No decoded frame';
    setText('#frames-stat-source', receiverConnected ? `${sourceName} · ${lastFrameAge}` : 'Awaiting signed receiver metrics');

    const processing = video.processing_ms;
    $('#processing-stat').innerHTML = `${formatMetric(processing)} <small>ms</small>`;
    setText('#processing-stat-state', processing == null ? 'NOT REPORTED' : 'MEASURED');
    $('#processing-stat-state').className = `trend ${processing == null ? 'neutral' : 'good'}`;
    setText('#processing-stat-detail', video.decrypt_errors || video.decode_errors ? `${video.decrypt_errors ?? 0} decrypt · ${video.decode_errors ?? 0} decode errors` : processing == null ? 'No receiver sample' : 'Decrypt + decode average');

    $('#transfer-stat').innerHTML = `${formatMetric(video.receive_megabytes_per_second, 3)} <small>MB/s</small>`;
    setText('#transfer-stat-state', receiverConnected ? (videoLive ? 'RECEIVING' : 'LISTENING') : 'NO DATA');
    setText('#transfer-stat-label', video.source === 'carframework_udp_receiver' ? 'Measured encrypted UDP ingress' : video.source === 'dashboard_websocket_jpeg' ? 'Measured WebSocket ingress' : 'Measured incoming data');
    $('#transfer-stat-state').className = `trend ${videoLive ? 'good' : 'neutral'}`;
    setText('#frame-size-label', video.source === 'dashboard_websocket_jpeg' ? 'Latest JPEG frame' : 'Latest AVIF frame');
    setText('#frame-size-stat', video.last_frame_size_bytes == null ? '—' : formatBytes(video.last_frame_size_bytes));

    renderRobotState(!!robot.control_connected, robot.telemetry || {});
    if (videoLive) setText('#system-pill-text', `${sourceName} · live`);
    else if (receiverConnected) setText('#system-pill-text', 'CarFramework receiver listening · no live frame');
    else if (robot.control_connected) setText('#system-pill-text', 'Robot control connected');
    else setText('#system-pill-text', 'API online · no device data');

    const observedState = {
      videoSource: video.source || null,
      videoLive,
      receiverConnected,
      controlConnected: !!robot.control_connected
    };
    const previous = state.lastObservedState;
    if (previous !== null) {
      if (previous.videoSource !== observedState.videoSource || previous.videoLive !== observedState.videoLive) {
        if (videoLive) addActivity('Video frames received', `${sourceName} is delivering decoded frames.`, 'mint');
        else if (receiverConnected) addActivity('Receiver connected', 'Metrics heartbeat received; waiting for a decoded frame.', 'cyan');
        else if (previous.videoSource) addActivity('Video feed stopped', 'No fresh frame or receiver heartbeat is being reported.', 'orange');
      }
      if (previous.controlConnected !== observedState.controlConnected) {
        addActivity(observedState.controlConnected ? 'Robot control connected' : 'Robot control disconnected', 'Authenticated control-link state changed.', observedState.controlConnected ? 'mint' : 'orange');
      }
    }
    state.lastObservedState = observedState;
  }

  async function refreshOperationalMetrics() {
    try {
      const data = await apiRequest('/api/metrics', { headers: { 'Cache-Control': 'no-cache' } });
      renderOperationalMetrics(data);
    } catch (error) {
      setText('#system-pill-text', 'Metrics unavailable');
      setText('#frames-stat-state', 'API ERROR');
      $('#frames-stat-state').className = 'trend warning';
      if (error.message && !/sign in/i.test(error.message)) console.warn('Metrics refresh failed:', error.message);
    }
  }

  function startMetricsPolling() {
    stopMetricsPolling();
    refreshOperationalMetrics();
    state.metricsTimer = window.setInterval(refreshOperationalMetrics, 1000);
  }

  function stopMetricsPolling() {
    if (state.metricsTimer) window.clearInterval(state.metricsTimer);
    state.metricsTimer = null;
  }


  async function refreshSecurityStatus(options = {}) {
    const refreshButton = $('#security-refresh');
    const tls = window.location.protocol === 'https:';
    setText('#security-web-transport', tls ? 'HTTPS / WSS' : 'HTTP / WS');
    setText('#security-web-detail', tls ? 'TLS protects the browser-facing connection' : (['localhost', '127.0.0.1', '::1'].includes(window.location.hostname) ? 'Local development · no network TLS' : 'No TLS on this connection · use HTTPS/WSS'));
    if (refreshButton) refreshButton.disabled = true;
    try {
      const data = await apiRequest('/api/security/status');
      const cf = data.carframework || {};
      const pqcEnabled = data.pqc_transport_enabled === true;
      const sourceAvailable = data.source_available === true;
      const tag = $('#security-state-tag');
      if (tag) {
        tag.className = `tag ${pqcEnabled ? 'tag-cyan' : 'tag-warning'}`;
        tag.innerHTML = `<span class="tag-dot"></span> ${pqcEnabled ? 'PQC VERIFIED' : 'PQC NOT VERIFIED'}`;
      }
      setText('#security-state-eyebrow', sourceAvailable ? 'SOURCE INSPECTED · RUNTIME STATUS' : 'SOURCE NOT AVAILABLE');
      setText('#security-state-title', sourceAvailable ? (cf.nonce_compatible === false ? 'Source configuration has an AES-GCM-SIV nonce mismatch' : 'Source found; cryptographic runtime is not verified') : 'CarFramework source files were not found');
      const runtimeCopy = data.receiver_reporter_recent
        ? `\n\nLive receiver report: ${data.receiver_state || 'unknown'} · ${data.receiver_datagrams ?? '—'} UDP datagrams · ${data.receiver_decrypt_errors ?? '—'} decrypt errors · ${data.receiver_decode_errors ?? '—'} decode errors · sender ${data.receiver_sender_ip || 'unknown'}.`
        : '\n\nNo receiver heartbeat has been received in the last five seconds.';
      setText('#security-state-copy', `${data.message || 'The backend could not determine the local CarFramework configuration.'}${runtimeCopy}`);
      const handshakeLabel = data.receiver_handshake_reported ? 'HANDSHAKE REPORTED' : (data.pqc_handshake_code_present ? 'SOURCE CODE FOUND' : 'NOT DETECTED');
      setText('#security-pqc-handshake', handshakeLabel);
      setText('#security-pqc-detail', data.receiver_processed_frame ? 'Receiver reported successful decrypt + decode' : data.receiver_handshake_reported ? 'Receiver reported handshake; no decoded frame yet' : 'No live receiver handshake report');
      setText('#security-device-auth', data.robot_token_configured ? 'TOKEN CONFIGURED' : 'TOKEN NOT SET');
      setText('#security-device-detail', data.robot_token_configured ? 'Dashboard WebSocket token is configured' : 'Dashboard WebSocket token is not configured');
      setText('#security-cookie-status', data.secure_cookie_configured ? 'SECURE' : 'NOT SECURE');
      setText('#security-cookie-detail', data.secure_cookie_configured ? 'Secure cookie flag is enabled' : 'Secure cookie flag is disabled');
      setText('#security-api-status', 'API REACHABLE');
      setText('#security-last-check', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setText('#security-source-tag', sourceAvailable ? 'SOURCE READ' : 'SOURCE MISSING');

      setText('#security-kem-name', cf.key_establishment || 'Not detected');
      setText('#security-kem-meta', cf.key_establishment ? 'Detected in encryption.py' : 'No KEM implementation detected');
      setText('#security-signature-name', cf.signature_scheme || 'Not detected');
      setText('#security-signature-copy', cf.signature_scheme ? `The source imports and uses ${cf.signature_scheme} for its signature operations.` : 'No ML-DSA parameter set was detected in encryption.py.');
      setText('#security-signature-meta', cf.signature_scheme ? 'Detected in encryption.py' : 'No signature parameter set found');
      setText('#security-kdf-name', cf.key_derivation || 'Not detected');
      setText('#security-kdf-copy', cf.key_derivation === 'HKDF' ? 'HKDF references were found in the source. Runtime derivation is not independently observed.' : 'No HKDF reference was detected in encryption.py.');
      setText('#security-kdf-meta', cf.key_derivation === 'HKDF' ? 'SOURCE REFERENCE FOUND' : 'NO HKDF REFERENCE');
      setText('#security-aead-name', cf.aead || 'Not detected');
      setText('#security-aead-copy', cf.nonce_compatible === false ? `Source sets a ${cf.configured_nonce_bytes}-byte nonce; ${cf.aead || 'AES-GCM-SIV'} requires ${cf.required_nonce_bytes} bytes.` : cf.nonce_compatible === true ? `Configured nonce length is ${cf.configured_nonce_bytes} bytes. Runtime encryption still requires independent testing.` : 'AEAD and nonce settings could not be read from the source.');
      setText('#security-aead-meta', cf.configured_nonce_bytes == null ? 'NONCE SETTING UNKNOWN' : `CONFIGURED ${cf.configured_nonce_bytes} BYTES · REQUIRED ${cf.required_nonce_bytes}`);

      if (sourceAvailable) {
        setText('#security-flow-handshake-title', `Key exchange · UDP ${cf.control_port ?? 'unknown'}`);
        setText('#security-flow-handshake-copy', `${cf.key_establishment || 'KEM not detected'} with ${cf.signature_scheme || 'signature scheme not detected'} in the supplied source.`);
        setText('#security-flow-video-title', `Video transport · UDP ${cf.video_port ?? 'unknown'}`);
        setText('#security-flow-video-copy', `${cf.aead || 'AEAD not detected'}; sender destination ${cf.sender_destination || 'not found'}.`);
        setText('#security-flow-decode-title', 'Receiver decode path');
        setText('#security-flow-decode-copy', 'The receiver source is inspected for its decode/display behaviour; live success is shown separately by receiver metrics.');
      } else {
        setText('#security-flow-handshake-title', 'Handshake source unavailable');
        setText('#security-flow-handshake-copy', 'Set CARFRAMEWORK_ROOT to the CarFramework checkout.');
        setText('#security-flow-video-title', 'Video source unavailable');
        setText('#security-flow-video-copy', 'Video format, AEAD and port were not read.');
        setText('#security-flow-decode-title', 'Receiver source unavailable');
        setText('#security-flow-decode-copy', 'No receiver implementation was available to inspect.');
      }

      const keyFiles = cf.local_key_files || {};
      const keyNames = Object.keys(keyFiles);
      const keyCount = keyNames.filter(name => keyFiles[name]).length;
      setText('#security-identity-title', keyNames.length ? (keyCount === keyNames.length ? 'All expected key files found locally' : `${keyCount} of ${keyNames.length} expected key files found locally`) : 'Local key-file status unavailable');
      setText('#security-identity-copy', keyNames.length ? 'Presence only is checked on the dashboard host. No private-key bytes are read or sent to the browser.' : 'Set CARFRAMEWORK_ROOT to the CarFramework checkout to inspect key-file presence.');
      setText('#security-key-files', keyNames.length ? `${keyCount}/${keyNames.length} present` : 'Unknown');
      if (!options.quiet) toast(sourceAvailable ? 'Security status refreshed from local source and runtime reports.' : 'CarFramework source folder was not found.', sourceAvailable ? 'success' : 'error');
    } catch (error) {
      const tag = $('#security-state-tag');
      if (tag) { tag.className = 'tag tag-warning'; tag.innerHTML = '<span class="tag-dot"></span> STATUS UNAVAILABLE'; }
      setText('#security-state-title', 'Could not gather security status');
      setText('#security-state-copy', error.message || 'The security endpoint could not be reached.');
      setText('#security-api-status', 'API UNAVAILABLE');
      setText('#security-device-auth', 'UNKNOWN');
      setText('#security-device-detail', 'Backend status could not be read');
      setText('#security-cookie-status', 'UNKNOWN');
      setText('#security-cookie-detail', 'Backend status could not be read');
      setText('#security-pqc-handshake', 'UNKNOWN');
      setText('#security-last-check', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      if (!options.quiet) toast(error.message || 'Could not refresh security status.', 'error');
    } finally {
      if (refreshButton) refreshButton.disabled = false;
    }
  }

  async function copySecurityChecklist() {
    let checklist = 'Aurora Glass / CarFramework runtime report\n\n';
    try {
      const data = await apiRequest('/api/security/status');
      const cf = data.carframework || {};
      checklist += `Source files available: ${data.source_available ? 'yes' : 'no'}\n`;
      checklist += `Key establishment: ${cf.key_establishment || 'not detected'}\n`;
      checklist += `Signature: ${cf.signature_scheme || 'not detected'}\n`;
      checklist += `Key derivation: ${cf.key_derivation || 'not detected'}\n`;
      checklist += `AEAD: ${cf.aead || 'not detected'}\n`;
      checklist += `Control UDP port: ${cf.control_port ?? 'unknown'}\n`;
      checklist += `Video UDP port: ${cf.video_port ?? 'unknown'}\n`;
      checklist += `Sender destination: ${cf.sender_destination || 'not detected'}\n`;
      checklist += `Configured nonce: ${cf.configured_nonce_bytes ?? 'unknown'} bytes (required: ${cf.required_nonce_bytes ?? 'unknown'})\n`;
      checklist += `Receiver metrics reporter configured: ${data.metrics_reporter_configured ? 'yes' : 'no'}\n`;
      checklist += `Dashboard metrics listener active: ${data.metrics_listener_active ? 'yes' : 'no'}\n`;
      checklist += `Receiver heartbeat recent: ${data.receiver_reporter_recent ? 'yes' : 'no'}\n`;
      checklist += `Decoded frame reported: ${data.receiver_processed_frame ? 'yes' : 'no'}\n`;
      checklist += `PQC verified by dashboard: no (not independently attested)\n`;
      checklist += `\n${data.message || ''}`;
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(checklist);
      else {
        const field = document.createElement('textarea'); field.value = checklist; field.setAttribute('readonly', '');
        field.style.position = 'fixed'; field.style.opacity = '0'; document.body.appendChild(field); field.select();
        const copied = document.execCommand('copy'); field.remove();
        if (!copied) throw new Error('Clipboard access is unavailable in this browser.');
      }
      toast('Current source and receiver status copied. No key material was copied.');
    } catch (error) { toast(error.message || 'Could not gather the security report.', 'error'); }
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
    setText('#stage-resolution', 'DEVICE FEED · JPEG');
    setCameraSourceText('Authenticated device feed', 'Live JPEG frames · dashboard WebSocket', 'ROBOT LIVE');
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
    socket.onopen = () => { if (state.cameraSocket === socket) toast('Camera viewer connected. Waiting for authenticated device frames.'); };
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
      setCameraSourceText('No source selected', 'Dashboard WebSocket viewer · waiting for device frames', 'NO SOURCE');
    };
  }

  function stopRobotCamera() {
    const socket = state.cameraSocket; state.cameraSocket = null; state.activeCamera = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    ['#robot-camera-element', '#studio-robot-camera'].forEach(sel => { const img = $(sel); img.removeAttribute('src'); img.classList.add('hidden'); });
    if (state.cameraFrameUrl) { URL.revokeObjectURL(state.cameraFrameUrl); state.cameraFrameUrl = null; }
    $('#recording-indicator').classList.add('hidden');
    ['#video-placeholder', '#studio-placeholder'].forEach(sel => sel && $(sel).classList.remove('hidden'));
    setCameraControls(''); setCameraSourceText('No source selected', 'Ready for a local file or authenticated WebSocket feed', 'NO SOURCE');
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
  ['#local-camera-start-top', '#dashboard-local-camera', '#studio-local-camera'].forEach(sel => { const node = $(sel); if (node) node.addEventListener('click', startLocalCamera); });
  ['#local-camera-stop-top', '#local-camera-stop-studio', '#dashboard-local-camera-stop'].forEach(sel => $(sel).addEventListener('click', stopLocalCamera));
  $('#connect-robot').addEventListener('click', connectRobot); $('#robot-connect-page').addEventListener('click', connectRobot); $('#quick-stop').addEventListener('click', updateRobotStop); $('#direction-stop').addEventListener('click', () => sendCommand('stop'));
  $$('.direction-btn[data-command]').forEach(button => button.addEventListener('click', () => sendCommand(button.dataset.command)));
  $('#quality-range').addEventListener('input', () => { state.quality = Number($('#quality-range').value); updateCodecUi(); });
  $$('.segment').forEach(button => button.addEventListener('click', () => { $$('.segment').forEach(item => item.classList.toggle('active', item === button)); state.codec = button.dataset.codec; updateCodecUi(); }));
  ['#resolution-setting', '#pixel-setting', '#metadata-toggle', '#chunks-toggle'].forEach(sel => $(sel).addEventListener('change', readCodecControls));
  $('#save-codec').addEventListener('click', saveCodec);
  $('#reset-codec').addEventListener('click', () => { state.codec = DEFAULTS.codec; state.quality = DEFAULTS.quality; state.resolution = DEFAULTS.resolution; state.pixel = DEFAULTS.pixel; state.metadata = DEFAULTS.metadata; state.chunks = DEFAULTS.chunks; applyPrefsToUi(); toast('Codec controls reset. Save profile to persist changes.'); });
  $('#save-settings').addEventListener('click', saveSettings); $('#save-network').addEventListener('click', saveNetwork);
  $('#security-refresh').addEventListener('click', () => refreshSecurityStatus());
  $('#security-copy-checklist').addEventListener('click', copySecurityChecklist);
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
      const map = [['dashboard', ['overview', 'dashboard', 'home']], ['video', ['video', 'media', 'stream', 'upload']], ['robot', ['robot', 'control', 'sensor', 'line']], ['codec', ['codec', 'avif', 'av1', 'quality', 'encode']], ['security', ['security', 'encryption', 'encrypt', 'quantum', 'pqc', 'kem', 'dsa', 'keys']], ['settings', ['settings', 'network', 'preferences', 'api']]];
      const match = map.find(([, words]) => words.some(word => query.includes(word)));
      if (match) { setView(match[0]); $('#search-strip').classList.add('hidden'); toast(`Opened ${match[0]}.`); }
      else toast('No matching dashboard section. Try video, robot, codec, security, or settings.', 'error');
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
