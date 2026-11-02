const $ = id => document.getElementById(id);
let frames = 0;
let running = false;
let errors = 0;

function setStatus(title, detail, state = '') {
  $('receiver-status').textContent = title;
  $('receiver-detail').textContent = detail;
  $('status-dot').className = `status-dot ${state}`;
}
function setRunning(value) {
  running = value;
  $('start').disabled = value;
  $('stop').disabled = !value;
  for (const id of ['sender-select', 'receiver-select', 'python']) $(id).disabled = value;
}
function clearFeed() {
  $('frame').hidden = true;
  $('placeholder').hidden = false;
  $('feed-tag').textContent = 'OFFLINE';
}
for (const name of ['sender', 'receiver']) {
  $(`${name}-select`).addEventListener('click', async () => {
    const selected = await window.receiver.chooseFile();
    if (selected) $(`${name}-key`).value = selected;
  });
}
$('start').addEventListener('click', async () => {
  try {
    setRunning(true);
    frames = 0; errors = 0;
    $('frame-count').textContent = 'No frames received';
    setStatus('Starting', 'Preparing connection');
    await window.receiver.start({ senderKey: $('sender-key').value, receiverKey: $('receiver-key').value, python: $('python').value });
  } catch (error) { setRunning(false); setStatus('Error', error.message, 'error'); }
});
$('stop').addEventListener('click', async () => {
  await window.receiver.stop();
  setRunning(false); clearFeed(); setStatus('Offline', 'Stopped by user');
});
window.receiver.onEvent(event => {
  if (event.type === 'frame') {
    frames++;
    $('frame').src = 'data:image/avif;base64,' + event.data;
    $('frame').hidden = false; $('placeholder').hidden = true;
    $('feed-tag').textContent = 'LIVE';
    $('frame-count').textContent = `${frames} frame${frames === 1 ? '' : 's'} received`;
    setStatus('Connected', 'Receiving video frames', 'connected');
  } else if (event.type === 'status') {
    const connected = event.message.startsWith('Connected');
    setStatus(connected ? 'Connected' : 'Listening', event.message, connected ? 'connected' : '');
  } else if (event.type === 'frame_error') {
    errors++;
    setStatus('Frame error', `${event.message} (${errors} failed)`, 'error');
  } else if (event.type === 'error') {
    setStatus('Error', event.message, 'error');
  } else if (event.type === 'diagnostic') {
    setStatus('Receiver', event.message, 'error');
  } else if (event.type === 'stopped' && running) {
    setRunning(false); clearFeed();
    if ($('receiver-status').textContent !== 'Error') setStatus('Offline', event.message);
  }
});
$('frame').addEventListener('error', () => { $('feed-tag').textContent = 'ERROR'; setStatus('Decode error', 'The received frame could not be displayed as AVIF.', 'error'); });
