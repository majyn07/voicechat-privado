'use strict';

/* =========================================================================
   VoiceChat renderer — WebRTC mesh (P2P) + audio pipeline + UI wiring
   ========================================================================= */

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const SPEAKING_THRESHOLD = 0.045;
const VAD_HANGOVER_MS = 320;

const $ = (id) => document.getElementById(id);

/* ---------- DOM refs ---------- */
const el = {
  loginScreen: $('login-screen'),
  loginForm: $('login-form'),
  loginServer: $('login-server'),
  loginRoom: $('login-room'),
  loginPassword: $('login-password'),
  loginName: $('login-name'),
  loginSubmit: $('login-submit'),
  loginError: $('login-error'),

  mainScreen: $('main-screen'),
  roomName: $('room-name'),
  connectionStatus: $('connection-status'),
  memberList: $('member-list'),
  openSettings: $('open-settings'),
  leaveRoom: $('leave-room'),

  videoGrid: $('video-grid'),
  emptyStageHint: $('empty-stage-hint'),

  toggleMic: $('toggle-mic'),
  toggleDeafen: $('toggle-deafen'),
  toggleCamera: $('toggle-camera'),
  toggleScreen: $('toggle-screen'),
  toggleChat: $('toggle-chat'),
  pttIndicator: $('ptt-indicator'),
  pttKeyLabel: $('ptt-key-label'),

  chatPanel: $('chat-panel'),
  closeChat: $('close-chat'),
  chatMessages: $('chat-messages'),
  chatForm: $('chat-form'),
  chatInput: $('chat-input'),

  settingsModal: $('settings-modal'),
  closeSettings: $('close-settings'),
  inputDeviceSelect: $('input-device-select'),
  outputDeviceSelect: $('output-device-select'),
  cameraDeviceSelect: $('camera-device-select'),
  echoCancellation: $('echo-cancellation'),
  noiseSuppression: $('noise-suppression'),
  autoGainControl: $('auto-gain-control'),
  inputGain: $('input-gain'),
  inputGainValue: $('input-gain-value'),
  micMeterFill: $('mic-meter-fill'),
  vadSensitivity: $('vad-sensitivity'),
  vadSensitivityValue: $('vad-sensitivity-value'),
  vadSensitivityRow: $('vad-sensitivity-row'),
  pttKeyRow: $('ptt-key-row'),
  pttKeyBind: $('ptt-key-bind'),
  globalMuteKeyBind: $('global-mute-key-bind'),
  includeSystemAudio: $('include-system-audio'),

  screenPickerModal: $('screen-picker-modal'),
  closeScreenPicker: $('close-screen-picker'),
  screenSourceGrid: $('screen-source-grid'),
};

/* ---------- persisted settings ---------- */
const DEFAULT_SETTINGS = {
  server: 'https://voicechat-signaling.onrender.com',
  room: '',
  name: '',
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputGainPct: 100,
  voiceMode: 'vad', // always | vad | ptt
  vadSensitivity: 35,
  pttKeyCode: 'Space',
  pttKeyLabel: 'Espaco',
  globalMuteAccelerator: 'CommandOrControl+Shift+M',
  globalMuteLabel: 'Ctrl+Shift+M',
  includeSystemAudio: false,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('voicechat.settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem('voicechat.settings', JSON.stringify(settings));
}

const settings = loadSettings();

/* ---------- global state ---------- */
const state = {
  socket: null,
  selfId: null,
  room: '',
  displayName: '',
  peers: new Map(), // id -> peerState
  manualMicMuted: false,
  deafened: false,
  cameraOn: false,
  screenOn: false,
  pttHeld: false,
  vadSpeaking: false,
  audioCtx: null,
  micRawStream: null,
  micSourceNode: null,
  micGainNode: null,
  micAnalyser: null,
  micDestNode: null,
  processedMicTrack: null,
  cameraTrack: null,
  cameraStream: null,
  screenTrack: null,
  screenStream: null,
  screenAudioTrack: null,
  localCameraTileId: 'local-camera',
  localScreenTileId: 'local-screen',
  micLevelRAF: null,
};

function makePeerState(id, name) {
  return {
    id,
    name,
    pc: null,
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    trackMeta: new Map(), // trackId -> kind
    pendingTracks: new Map(), // trackId -> MediaStreamTrack
    micAudioEl: null,
    micGainNode: null,
    micAnalyser: null,
    micSourceNode: null,
    micDestNode: null,
    volume: 1,
    speaking: false,
    micMuted: false,
    cameraOn: false,
    screenOn: false,
  };
}

/* =========================================================================
   LOGIN
   ========================================================================= */

el.loginServer.value = settings.server;
el.loginRoom.value = settings.room;
el.loginName.value = settings.name;

el.loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  el.loginError.textContent = '';
  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = 'Conectando...';

  try {
    await connectToServer({
      server: el.loginServer.value.trim(),
      room: el.loginRoom.value.trim(),
      password: el.loginPassword.value,
      name: el.loginName.value.trim(),
    });
  } catch (err) {
    el.loginError.textContent = err && err.message ? err.message : 'Falha ao conectar.';
    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = 'Entrar na sala';
  }
});

function connectToServer({ server, room, password, name }) {
  return new Promise((resolve, reject) => {
    if (!server) return reject(new Error('Informe o endereco do servidor.'));

    let url = server;
    if (!/^https?:\/\//i.test(url) && !/^wss?:\/\//i.test(url)) url = 'https://' + url;
    url = url.replace(/^ws/, 'http');

    const socket = io(url, { transports: ['websocket', 'polling'], reconnection: true });
    let settled = false;

    const failTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error('Tempo esgotado ao conectar no servidor.'));
    }, 12000);

    socket.on('connect_error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimeout);
      reject(new Error('Nao foi possivel conectar: ' + err.message));
    });

    socket.on('connect', () => {
      socket.emit('join', { room, password, name });
    });

    socket.on('join-error', ({ message }) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimeout);
      socket.close();
      reject(new Error(message || 'Erro ao entrar na sala.'));
    });

    socket.on('joined', async ({ selfId, room: joinedRoom, peers }) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimeout);

      state.socket = socket;
      state.selfId = selfId;
      state.room = joinedRoom;
      state.displayName = name;

      settings.server = server;
      settings.room = room;
      settings.name = name;
      saveSettings();

      registerSocketHandlers(socket);
      await enterRoomUI(joinedRoom);

      try {
        await ensureMicPipeline();
      } catch (err) {
        pushSystemMessage('Nao foi possivel acessar o microfone: ' + (err && err.message ? err.message : err));
      }

      for (const p of peers) {
        addPeer(p.id, p.name, /*polite*/ compareIds(selfId, p.id));
      }

      resolve();
    });
  });
}

function compareIds(selfId, otherId) {
  // Deterministic politeness: the "smaller" id is polite.
  return selfId > otherId;
}

/* =========================================================================
   SOCKET EVENT HANDLERS
   ========================================================================= */

function registerSocketHandlers(socket) {
  socket.on('peer-joined', ({ id, name }) => {
    addPeer(id, name, compareIds(state.selfId, id));
    pushSystemMessage(`${name} entrou na sala.`);
  });

  socket.on('peer-left', ({ id }) => {
    const peer = state.peers.get(id);
    if (peer) {
      pushSystemMessage(`${peer.name} saiu da sala.`);
      removePeer(id);
    }
  });

  socket.on('signal', async ({ from, data }) => {
    const peer = state.peers.get(from);
    if (!peer) return;
    try {
      await handleSignal(peer, data);
    } catch (err) {
      console.error('signal handling error', err);
    }
  });

  socket.on('chat', ({ from, name, text, ts }) => {
    pushChatMessage({ mine: from === state.selfId, name, text, ts });
  });

  socket.on('peer-state', ({ id, ...partial }) => {
    const peer = state.peers.get(id);
    if (!peer) return;
    Object.assign(peer, partial);
    renderMemberList();
  });

  socket.on('disconnect', () => {
    setConnectionStatus('desconectado', 'err');
  });

  socket.on('connect', () => {
    setConnectionStatus('conectado', 'ok');
  });
}

function setConnectionStatus(text, cls) {
  el.connectionStatus.textContent = text;
  el.connectionStatus.className = 'connection-status ' + (cls || '');
}

/* =========================================================================
   PEER CONNECTION MANAGEMENT (perfect negotiation)
   ========================================================================= */

function addPeer(id, name, polite) {
  if (state.peers.has(id)) return;
  const peer = makePeerState(id, name);
  peer.polite = polite;

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  peer.pc = pc;
  state.peers.set(id, peer);

  pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await pc.setLocalDescription();
      state.socket.emit('signal', { to: id, data: { type: 'sdp', description: pc.localDescription } });
    } catch (err) {
      console.error('negotiation error', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('signal', { to: id, data: { type: 'ice', candidate } });
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) {
      // leave cleanup to peer-left / explicit removal
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    peer.pendingTracks.set(track.id, track);
    track.addEventListener('ended', () => handleRemoteTrackEnded(peer, track));
    tryResolvePeerTrack(peer, track.id);
  };

  // attach whatever local tracks are already active
  addExistingLocalTracksToPeer(peer);

  renderMemberList();
  return peer;
}

function addExistingLocalTracksToPeer(peer) {
  if (state.processedMicTrack) attachTrackToPeer(peer, state.processedMicTrack, 'mic');
  if (state.cameraTrack) attachTrackToPeer(peer, state.cameraTrack, 'camera');
  if (state.screenTrack) attachTrackToPeer(peer, state.screenTrack, 'screen');
}

function attachTrackToPeer(peer, track, kind) {
  const sender = peer.pc.addTrack(track, new MediaStream([track]));
  peer._senders = peer._senders || {};
  peer._senders[kind] = sender;
  state.socket.emit('signal', { to: peer.id, data: { type: 'track-meta', trackId: track.id, kind } });
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  try { peer.pc.close(); } catch {}
  if (peer.micAudioEl) {
    peer.micAudioEl.pause();
    peer.micAudioEl.remove();
  }
  if (peer.screenAudioEl) {
    peer.screenAudioEl.pause();
    peer.screenAudioEl.remove();
  }
  removeVideoTile(`${id}-camera`);
  removeVideoTile(`${id}-screen`);
  state.peers.delete(id);
  renderMemberList();
}

async function handleSignal(peer, data) {
  if (data.type === 'sdp') {
    const description = data.description;
    const offerCollision = description.type === 'offer' &&
      (peer.makingOffer || peer.pc.signalingState !== 'stable');

    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;

    if (offerCollision) {
      await Promise.all([
        peer.pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
        peer.pc.setRemoteDescription(description),
      ]);
    } else {
      await peer.pc.setRemoteDescription(description);
    }

    if (description.type === 'offer') {
      await peer.pc.setLocalDescription();
      state.socket.emit('signal', {
        to: peer.id,
        data: { type: 'sdp', description: peer.pc.localDescription },
      });
    }
  } else if (data.type === 'ice') {
    try {
      await peer.pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) console.error('ICE add error', err);
    }
  } else if (data.type === 'track-meta') {
    peer.trackMeta.set(data.trackId, data.kind);
    tryResolvePeerTrack(peer, data.trackId);
  }
}

function tryResolvePeerTrack(peer, trackId) {
  const kind = peer.trackMeta.get(trackId);
  const track = peer.pendingTracks.get(trackId);
  if (!kind || !track) return;
  peer.pendingTracks.delete(trackId);

  if (kind === 'mic') attachRemoteMicTrack(peer, track);
  else if (kind === 'camera') attachRemoteVideoTrack(peer, track, 'camera');
  else if (kind === 'screen') attachRemoteVideoTrack(peer, track, 'screen');
  else if (kind === 'screen-audio') attachRemoteScreenAudioTrack(peer, track);
}

function attachRemoteScreenAudioTrack(peer, track) {
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.srcObject = new MediaStream([track]);
  if (settings.outputDeviceId && audioEl.setSinkId) {
    audioEl.setSinkId(settings.outputDeviceId).catch(() => {});
  }
  document.body.appendChild(audioEl);
  peer.screenAudioEl = audioEl;
  track.addEventListener('ended', () => {
    audioEl.pause();
    audioEl.remove();
    peer.screenAudioEl = null;
  });
}

function handleRemoteTrackEnded(peer, track) {
  const kind = peer.trackMeta.get(track.id);
  peer.trackMeta.delete(track.id);
  peer.pendingTracks.delete(track.id);
  if (kind === 'camera') { peer.cameraOn = false; removeVideoTile(`${peer.id}-camera`); renderMemberList(); }
  if (kind === 'screen') { peer.screenOn = false; removeVideoTile(`${peer.id}-screen`); renderMemberList(); }
}

/* ---------- remote mic audio graph (per-user volume + speaking meter + output device) ---------- */
function attachRemoteMicTrack(peer, track) {
  ensureAudioCtx();
  const stream = new MediaStream([track]);
  const sourceNode = state.audioCtx.createMediaStreamSource(stream);
  const gainNode = state.audioCtx.createGain();
  gainNode.gain.value = state.deafened ? 0 : peer.volume;
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  const destNode = state.audioCtx.createMediaStreamDestination();

  sourceNode.connect(gainNode);
  gainNode.connect(analyser);
  analyser.connect(destNode);

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.srcObject = destNode.stream;
  if (settings.outputDeviceId && audioEl.setSinkId) {
    audioEl.setSinkId(settings.outputDeviceId).catch(() => {});
  }
  document.body.appendChild(audioEl);

  peer.micSourceNode = sourceNode;
  peer.micGainNode = gainNode;
  peer.micAnalyser = analyser;
  peer.micDestNode = destNode;
  peer.micAudioEl = audioEl;

  monitorPeerSpeaking(peer);
}

function monitorPeerSpeaking(peer) {
  const buf = new Uint8Array(peer.micAnalyser.fftSize);
  let hangoverUntil = 0;
  function tick() {
    if (!state.peers.has(peer.id) || !peer.micAnalyser) return;
    peer.micAnalyser.getByteTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    const now = performance.now();
    if (rms > SPEAKING_THRESHOLD) hangoverUntil = now + VAD_HANGOVER_MS;
    const speaking = now < hangoverUntil;
    if (speaking !== peer.speaking) {
      peer.speaking = speaking;
      renderMemberList();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ---------- remote video (camera / screen share) ---------- */
function attachRemoteVideoTrack(peer, track, kind) {
  const tileId = `${peer.id}-${kind}`;
  const stream = new MediaStream([track]);
  upsertVideoTile(tileId, stream, `${peer.name}${kind === 'screen' ? ' (tela)' : ''}`, false);
  if (kind === 'camera') peer.cameraOn = true;
  if (kind === 'screen') peer.screenOn = true;
  renderMemberList();
}

/* =========================================================================
   VIDEO GRID
   ========================================================================= */

function upsertVideoTile(tileId, stream, label, muted) {
  let tile = document.getElementById(`tile-${tileId}`);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = `tile-${tileId}`;
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!muted;
    const labelEl = document.createElement('div');
    labelEl.className = 'tile-label';
    tile.appendChild(video);
    tile.appendChild(labelEl);
    el.videoGrid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.tile-label').textContent = label;
  updateEmptyStageHint();
}

function removeVideoTile(tileId) {
  const tile = document.getElementById(`tile-${tileId}`);
  if (tile) tile.remove();
  updateEmptyStageHint();
}

function updateEmptyStageHint() {
  el.emptyStageHint.classList.toggle('hidden', el.videoGrid.children.length > 0);
}

/* =========================================================================
   LOCAL AUDIO PIPELINE (mic capture -> gain -> analyser -> processed track)
   ========================================================================= */

function ensureAudioCtx() {
  if (!state.audioCtx) state.audioCtx = new AudioContext();
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
}

async function ensureMicPipeline() {
  await rebuildMicStream();
  startMicLevelLoop();
  applyMicEnabledState();
}

async function rebuildMicStream() {
  ensureAudioCtx();

  const constraints = {
    audio: {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      deviceId: settings.inputDeviceId ? { exact: settings.inputDeviceId } : undefined,
    },
  };

  const newRawStream = await navigator.mediaDevices.getUserMedia(constraints);
  const newTrack = newRawStream.getAudioTracks()[0];

  if (state.micSourceNode) state.micSourceNode.disconnect();
  if (state.micRawStream) state.micRawStream.getTracks().forEach((t) => t.stop());

  state.micRawStream = newRawStream;
  state.micSourceNode = state.audioCtx.createMediaStreamSource(newRawStream);

  if (!state.micGainNode) state.micGainNode = state.audioCtx.createGain();
  state.micGainNode.gain.value = settings.inputGainPct / 100;

  if (!state.micAnalyser) {
    state.micAnalyser = state.audioCtx.createAnalyser();
    state.micAnalyser.fftSize = 512;
  }
  if (!state.micDestNode) state.micDestNode = state.audioCtx.createMediaStreamDestination();

  state.micSourceNode.connect(state.micGainNode);
  state.micGainNode.connect(state.micAnalyser);
  state.micAnalyser.connect(state.micDestNode);

  const newProcessedTrack = state.micDestNode.stream.getAudioTracks()[0];

  if (state.processedMicTrack) {
    // swap in-place on every peer connection to avoid renegotiation churn
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders.mic;
      if (sender) sender.replaceTrack(newProcessedTrack).catch(() => {});
    }
    newProcessedTrack.enabled = state.processedMicTrack.enabled;
  }
  state.processedMicTrack = newProcessedTrack;

  populateDeviceLists();
  return newProcessedTrack;
}

function startMicLevelLoop() {
  if (state.micLevelRAF) cancelAnimationFrame(state.micLevelRAF);
  const buf = new Uint8Array(state.micAnalyser.fftSize);
  let vadHangoverUntil = 0;

  function tick() {
    state.micLevelRAF = requestAnimationFrame(tick);
    if (!state.micAnalyser) return;
    state.micAnalyser.getByteTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / buf.length);
    el.micMeterFill.style.width = `${Math.min(100, rms * 260)}%`;

    if (settings.voiceMode === 'vad') {
      const threshold = 0.08 * (1 - settings.vadSensitivity / 100) + 0.006;
      const now = performance.now();
      if (rms > threshold) vadHangoverUntil = now + VAD_HANGOVER_MS;
      const speaking = now < vadHangoverUntil;
      if (speaking !== state.vadSpeaking) {
        state.vadSpeaking = speaking;
        applyMicEnabledState();
      }
    }

    const localSpeaking = !!state.processedMicTrack && state.processedMicTrack.enabled && rms > SPEAKING_THRESHOLD;
    setLocalSpeakingIndicator(localSpeaking);
  }
  tick();
}

function setLocalSpeakingIndicator(speaking) {
  const row = document.getElementById('member-self');
  if (row) row.classList.toggle('speaking', speaking);
}

function applyMicEnabledState() {
  if (!state.processedMicTrack) return;
  let enabled;
  if (state.manualMicMuted || state.deafened) {
    enabled = false;
  } else if (settings.voiceMode === 'always') {
    enabled = true;
  } else if (settings.voiceMode === 'ptt') {
    enabled = state.pttHeld;
  } else {
    enabled = state.vadSpeaking;
  }
  state.processedMicTrack.enabled = enabled;

  el.pttIndicator.classList.toggle('talking', settings.voiceMode === 'ptt' && enabled);
  updateMicButtonUI();
}

function updateMicButtonUI() {
  el.toggleMic.classList.toggle('muted', state.manualMicMuted || state.deafened);
  el.toggleMic.querySelector('.lbl').textContent = (state.manualMicMuted || state.deafened) ? 'Mutado' : 'Mic';
}

/* =========================================================================
   CAMERA / SCREEN SHARE
   ========================================================================= */

async function toggleCamera() {
  if (state.cameraOn) {
    stopCamera();
    return;
  }
  try {
    const constraints = {
      video: {
        deviceId: settings.cameraDeviceId ? { exact: settings.cameraDeviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    state.cameraStream = stream;
    state.cameraTrack = track;
    state.cameraOn = true;

    track.addEventListener('ended', stopCamera);

    for (const peer of state.peers.values()) attachTrackToPeer(peer, track, 'camera');
    upsertVideoTile('local-camera', new MediaStream([track]), 'Voce (camera)', true);
    populateDeviceLists();
  } catch (err) {
    pushSystemMessage('Nao foi possivel acessar a camera: ' + (err && err.message ? err.message : err));
  }
  updateToggleButtonsUI();
}

function stopCamera() {
  if (state.cameraTrack) {
    state.cameraTrack.stop();
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders.camera;
      if (sender) {
        peer.pc.removeTrack(sender);
        delete peer._senders.camera;
      }
    }
  }
  state.cameraTrack = null;
  state.cameraStream = null;
  state.cameraOn = false;
  removeVideoTile('local-camera');
  updateToggleButtonsUI();
}

async function toggleScreen() {
  if (state.screenOn) {
    stopScreen();
    return;
  }
  openScreenPicker();
}

async function startScreenShare(sourceId) {
  try {
    const constraints = {
      audio: settings.includeSystemAudio
        ? { mandatory: { chromeMediaSource: 'desktop' } }
        : false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      },
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const track = stream.getVideoTracks()[0];
    state.screenStream = stream;
    state.screenTrack = track;
    state.screenOn = true;

    track.addEventListener('ended', stopScreen);

    for (const peer of state.peers.values()) attachTrackToPeer(peer, track, 'screen');

    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      state.screenAudioTrack = audioTrack;
      for (const peer of state.peers.values()) attachTrackToPeer(peer, audioTrack, 'screen-audio');
    }

    upsertVideoTile('local-screen', new MediaStream([track]), 'Voce (tela)', true);
  } catch (err) {
    pushSystemMessage('Nao foi possivel compartilhar a tela: ' + (err && err.message ? err.message : err));
  }
  updateToggleButtonsUI();
}

function stopScreen() {
  if (state.screenTrack) {
    state.screenTrack.stop();
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders.screen;
      if (sender) {
        peer.pc.removeTrack(sender);
        delete peer._senders.screen;
      }
    }
  }
  if (state.screenAudioTrack) {
    state.screenAudioTrack.stop();
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders['screen-audio'];
      if (sender) {
        peer.pc.removeTrack(sender);
        delete peer._senders['screen-audio'];
      }
    }
    state.screenAudioTrack = null;
  }
  state.screenTrack = null;
  state.screenStream = null;
  state.screenOn = false;
  removeVideoTile('local-screen');
  updateToggleButtonsUI();
}

function updateToggleButtonsUI() {
  el.toggleCamera.classList.toggle('active', state.cameraOn);
  el.toggleScreen.classList.toggle('active', state.screenOn);
  state.socket && state.socket.emit('state', { cameraOn: state.cameraOn, screenOn: state.screenOn });
}

/* ---------- screen source picker ---------- */
async function openScreenPicker() {
  el.screenSourceGrid.innerHTML = '<p style="color:var(--text-dim);font-size:12.5px;">Carregando...</p>';
  el.screenPickerModal.classList.remove('hidden');
  const sources = await window.voicechat.getScreenSources();
  el.screenSourceGrid.innerHTML = '';
  for (const src of sources) {
    const div = document.createElement('div');
    div.className = 'screen-source';
    div.innerHTML = `<img src="${src.thumbnail}" /><div class="src-name">${escapeHtml(src.name)}</div>`;
    div.addEventListener('click', () => {
      el.screenPickerModal.classList.add('hidden');
      startScreenShare(src.id);
    });
    el.screenSourceGrid.appendChild(div);
  }
}
el.closeScreenPicker.addEventListener('click', () => el.screenPickerModal.classList.add('hidden'));

/* =========================================================================
   MEMBER LIST / UI
   ========================================================================= */

function renderMemberList() {
  el.memberList.innerHTML = '';
  el.memberList.appendChild(buildMemberRow({
    id: 'self',
    rowId: 'member-self',
    name: state.displayName + ' (voce)',
    micMuted: state.manualMicMuted || state.deafened,
    cameraOn: state.cameraOn,
    screenOn: state.screenOn,
    isSelf: true,
  }));

  for (const peer of state.peers.values()) {
    el.memberList.appendChild(buildMemberRow({
      id: peer.id,
      rowId: `member-${peer.id}`,
      name: peer.name,
      micMuted: !!peer.micMuted,
      cameraOn: !!peer.cameraOn,
      screenOn: !!peer.screenOn,
      speaking: !!peer.speaking,
      isSelf: false,
      peer,
    }));
  }
}

function buildMemberRow({ id, rowId, name, micMuted, cameraOn, screenOn, speaking, isSelf, peer }) {
  const row = document.createElement('div');
  row.className = 'member' + (speaking ? ' speaking' : '');
  row.id = rowId;

  const avatar = document.createElement('div');
  avatar.className = 'member-avatar';
  avatar.textContent = (name || '?').trim().slice(0, 2).toUpperCase();

  const nameEl = document.createElement('div');
  nameEl.className = 'member-name';
  nameEl.textContent = name;

  const icons = document.createElement('div');
  icons.className = 'member-icons';
  icons.textContent = [
    micMuted ? '🔇' : '',
    cameraOn ? '📷' : '',
    screenOn ? '🖥️' : '',
  ].filter(Boolean).join(' ');

  row.appendChild(avatar);
  row.appendChild(nameEl);
  row.appendChild(icons);

  if (!isSelf && peer) {
    const volWrap = document.createElement('div');
    volWrap.className = 'member-volume';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '200';
    range.value = String(Math.round(peer.volume * 100));
    range.title = 'Volume individual';
    range.addEventListener('input', () => {
      peer.volume = Number(range.value) / 100;
      if (peer.micGainNode) peer.micGainNode.gain.value = state.deafened ? 0 : peer.volume;
    });
    volWrap.appendChild(range);
    row.appendChild(volWrap);
  }

  return row;
}

/* =========================================================================
   CONTROL BAR
   ========================================================================= */

el.toggleMic.addEventListener('click', () => {
  state.manualMicMuted = !state.manualMicMuted;
  applyMicEnabledState();
  state.socket.emit('state', { micMuted: state.manualMicMuted });
});

el.toggleDeafen.addEventListener('click', () => {
  state.deafened = !state.deafened;
  el.toggleDeafen.classList.toggle('active', state.deafened);
  for (const peer of state.peers.values()) {
    if (peer.micGainNode) peer.micGainNode.gain.value = state.deafened ? 0 : peer.volume;
  }
  applyMicEnabledState();
  state.socket.emit('state', { deafened: state.deafened, micMuted: state.manualMicMuted || state.deafened });
});

el.toggleCamera.addEventListener('click', toggleCamera);
el.toggleScreen.addEventListener('click', toggleScreen);

el.toggleChat.addEventListener('click', () => el.chatPanel.classList.toggle('hidden'));
el.closeChat.addEventListener('click', () => el.chatPanel.classList.add('hidden'));

el.leaveRoom.addEventListener('click', () => {
  window.location.reload();
});

/* =========================================================================
   CHAT (text only)
   ========================================================================= */

el.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text) return;
  state.socket.emit('chat', { text });
  el.chatInput.value = '';
});

function pushChatMessage({ mine, name, text, ts }) {
  const div = document.createElement('div');
  div.className = 'chat-msg';
  const time = new Date(ts || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `<span class="who${mine ? ' me' : ''}">${escapeHtml(name)}</span><span class="when">${time}</span><div class="body"></div>`;
  div.querySelector('.body').textContent = text;
  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function pushSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'chat-msg system';
  div.textContent = text;
  el.chatMessages.appendChild(div);
  el.chatMessages.scrollTop = el.chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* =========================================================================
   SETTINGS MODAL
   ========================================================================= */

el.openSettings.addEventListener('click', () => {
  el.settingsModal.classList.remove('hidden');
  populateDeviceLists();
});
el.closeSettings.addEventListener('click', () => el.settingsModal.classList.add('hidden'));

async function populateDeviceLists() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    fillSelect(el.inputDeviceSelect, devices.filter((d) => d.kind === 'audioinput'), settings.inputDeviceId, 'Microfone');
    fillSelect(el.outputDeviceSelect, devices.filter((d) => d.kind === 'audiooutput'), settings.outputDeviceId, 'Alto-falante');
    fillSelect(el.cameraDeviceSelect, devices.filter((d) => d.kind === 'videoinput'), settings.cameraDeviceId, 'Camera');
  } catch (err) {
    console.error('enumerateDevices failed', err);
  }
}

function fillSelect(selectEl, devices, currentId, fallbackLabel) {
  selectEl.innerHTML = '';
  const defaultOpt = document.createElement('option');
  defaultOpt.value = '';
  defaultOpt.textContent = `Padrao do sistema`;
  selectEl.appendChild(defaultOpt);
  devices.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    selectEl.appendChild(opt);
  });
  selectEl.value = currentId || '';
}

el.inputDeviceSelect.addEventListener('change', async () => {
  settings.inputDeviceId = el.inputDeviceSelect.value;
  saveSettings();
  await rebuildMicStream();
});

el.outputDeviceSelect.addEventListener('change', () => {
  settings.outputDeviceId = el.outputDeviceSelect.value;
  saveSettings();
  for (const peer of state.peers.values()) {
    if (peer.micAudioEl && peer.micAudioEl.setSinkId) {
      peer.micAudioEl.setSinkId(settings.outputDeviceId).catch(() => {});
    }
  }
});

el.cameraDeviceSelect.addEventListener('change', async () => {
  settings.cameraDeviceId = el.cameraDeviceSelect.value;
  saveSettings();
  if (state.cameraOn) {
    stopCamera();
    await toggleCamera();
  }
});

for (const [checkboxEl, key] of [
  [el.echoCancellation, 'echoCancellation'],
  [el.noiseSuppression, 'noiseSuppression'],
  [el.autoGainControl, 'autoGainControl'],
]) {
  checkboxEl.checked = settings[key];
  checkboxEl.addEventListener('change', async () => {
    settings[key] = checkboxEl.checked;
    saveSettings();
    await rebuildMicStream();
  });
}

el.inputGain.value = String(settings.inputGainPct);
el.inputGainValue.textContent = settings.inputGainPct + '%';
el.inputGain.addEventListener('input', () => {
  settings.inputGainPct = Number(el.inputGain.value);
  el.inputGainValue.textContent = settings.inputGainPct + '%';
  if (state.micGainNode) state.micGainNode.gain.value = settings.inputGainPct / 100;
  saveSettings();
});

el.vadSensitivity.value = String(settings.vadSensitivity);
el.vadSensitivityValue.textContent = settings.vadSensitivity + '%';
el.vadSensitivity.addEventListener('input', () => {
  settings.vadSensitivity = Number(el.vadSensitivity.value);
  el.vadSensitivityValue.textContent = settings.vadSensitivity + '%';
  saveSettings();
});

el.includeSystemAudio.checked = settings.includeSystemAudio;
el.includeSystemAudio.addEventListener('change', () => {
  settings.includeSystemAudio = el.includeSystemAudio.checked;
  saveSettings();
});

document.querySelectorAll('input[name="voice-mode"]').forEach((radio) => {
  radio.checked = radio.value === settings.voiceMode;
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    settings.voiceMode = radio.value;
    saveSettings();
    el.vadSensitivityRow.classList.toggle('hidden', settings.voiceMode !== 'vad');
    el.pttKeyRow.classList.toggle('hidden', settings.voiceMode !== 'ptt');
    el.pttIndicator.classList.toggle('hidden', settings.voiceMode !== 'ptt');
    applyMicEnabledState();
  });
});
el.vadSensitivityRow.classList.toggle('hidden', settings.voiceMode !== 'vad');
el.pttKeyRow.classList.toggle('hidden', settings.voiceMode !== 'ptt');
el.pttIndicator.classList.toggle('hidden', settings.voiceMode !== 'ptt');
el.pttKeyLabel.textContent = settings.pttKeyLabel;

/* ---------- push-to-talk in-app key bind ---------- */
el.pttKeyBind.textContent = settings.pttKeyLabel;
el.pttKeyBind.addEventListener('click', () => {
  el.pttKeyBind.textContent = 'Pressione uma tecla...';
  el.pttKeyBind.classList.add('listening');
  const onKey = (e) => {
    e.preventDefault();
    settings.pttKeyCode = e.code;
    settings.pttKeyLabel = friendlyKeyLabel(e.code);
    el.pttKeyBind.textContent = settings.pttKeyLabel;
    el.pttKeyLabel.textContent = settings.pttKeyLabel;
    el.pttKeyBind.classList.remove('listening');
    saveSettings();
    window.removeEventListener('keydown', onKey, true);
  };
  window.addEventListener('keydown', onKey, true);
});

function friendlyKeyLabel(code) {
  if (code === 'Space') return 'Espaco';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

document.addEventListener('keydown', (e) => {
  if (settings.voiceMode !== 'ptt') return;
  if (isTypingTarget(e.target)) return;
  if (e.code === settings.pttKeyCode && !state.pttHeld) {
    state.pttHeld = true;
    applyMicEnabledState();
  }
});
document.addEventListener('keyup', (e) => {
  if (settings.voiceMode !== 'ptt') return;
  if (e.code === settings.pttKeyCode && state.pttHeld) {
    state.pttHeld = false;
    applyMicEnabledState();
  }
});
function isTypingTarget(target) {
  return target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
}

/* quick mute toggle via "M" key when not typing */
document.addEventListener('keydown', (e) => {
  if (isTypingTarget(e.target)) return;
  if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    el.toggleMic.click();
  }
});

/* ---------- global (system-wide) mute hotkey ---------- */
el.globalMuteKeyBind.textContent = settings.globalMuteLabel;
el.globalMuteKeyBind.addEventListener('click', () => {
  el.globalMuteKeyBind.textContent = 'Pressione uma combinacao...';
  el.globalMuteKeyBind.classList.add('listening');
  const onKey = async (e) => {
    e.preventDefault();
    const accel = buildAccelerator(e);
    if (!accel) return; // wait for a non-modifier key
    window.removeEventListener('keydown', onKey, true);
    settings.globalMuteAccelerator = accel.accelerator;
    settings.globalMuteLabel = accel.label;
    el.globalMuteKeyBind.textContent = accel.label;
    el.globalMuteKeyBind.classList.remove('listening');
    saveSettings();
    await registerGlobalMuteHotkey();
  };
  window.addEventListener('keydown', onKey, true);
});

function buildAccelerator(e) {
  const nonModifier = keyEventToAcceleratorKey(e.code);
  if (!nonModifier) return null; // still just a modifier
  const parts = [];
  const labelParts = [];
  if (e.ctrlKey || e.metaKey) { parts.push('CommandOrControl'); labelParts.push('Ctrl'); }
  if (e.shiftKey) { parts.push('Shift'); labelParts.push('Shift'); }
  if (e.altKey) { parts.push('Alt'); labelParts.push('Alt'); }
  parts.push(nonModifier);
  labelParts.push(nonModifier);
  return { accelerator: parts.join('+'), label: labelParts.join('+') };
}

function keyEventToAcceleratorKey(code) {
  if (['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'].includes(code)) return null;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Space') return 'Space';
  return code;
}

async function registerGlobalMuteHotkey() {
  if (!window.voicechat) return;
  const res = await window.voicechat.setMuteHotkey(settings.globalMuteAccelerator);
  if (!res || !res.ok) {
    pushSystemMessage('Nao foi possivel registrar o atalho global (talvez ja esteja em uso por outro app).');
  }
}

if (window.voicechat && window.voicechat.onHotkeyToggleMute) {
  window.voicechat.onHotkeyToggleMute(() => {
    el.toggleMic.click();
  });
}

/* =========================================================================
   ROOM ENTRY UI
   ========================================================================= */

async function enterRoomUI(roomId) {
  el.loginScreen.classList.add('hidden');
  el.mainScreen.classList.remove('hidden');
  el.roomName.textContent = roomId;
  setConnectionStatus('conectado', 'ok');
  renderMemberList();
  updateEmptyStageHint();
  await registerGlobalMuteHotkey();
}

window.addEventListener('beforeunload', () => {
  if (state.socket) state.socket.close();
});
