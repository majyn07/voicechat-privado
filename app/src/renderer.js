'use strict';

/* =========================================================================
   VoiceChat renderer — WebRTC mesh (P2P) + audio pipeline + UI wiring
   ========================================================================= */

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  // Servidores TURN (retransmissao) publicos do Open Relay Project — usados
  // como fallback quando a conexao direta P2P nao consegue atravessar o NAT
  // de uma ou ambas as redes (comum em redes moveis/CGNAT).
  { urls: 'turn:global.relay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:global.relay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];
const SPEAKING_THRESHOLD = 0.045;
const VAD_HANGOVER_MS = 320;

const $ = (id) => document.getElementById(id);

/* ---------- DOM refs ---------- */
const el = {
  loginScreen: $('login-screen'),
  loginForm: $('login-form'),
  loginServer: $('login-server'),
  loginPassword: $('login-password'),
  loginName: $('login-name'),
  loginSubmit: $('login-submit'),
  loginError: $('login-error'),
  loginSwitchAccount: $('login-switch-account'),
  loginForgetLink: $('login-forget-link'),

  mainScreen: $('main-screen'),
  roomName: $('room-name'),
  connectionStatus: $('connection-status'),
  memberList: $('member-list'),
  channelList: $('channel-list'),
  dmList: $('dm-list'),
  addChannelBtn: $('add-channel-btn'),
  addChannelForm: $('add-channel-form'),
  addChannelInput: $('add-channel-input'),
  channelHeader: $('channel-header'),
  chatHeaderTitle: $('chat-header-title'),
  openSettings: $('open-settings'),
  leaveRoom: $('leave-room'),

  videoGrid: $('video-grid'),
  emptyStageHint: $('empty-stage-hint'),
  videoSpotlight: $('video-spotlight'),
  videoFocus: $('video-focus'),
  videoStrip: $('video-strip'),
  spotlightFullscreen: $('spotlight-fullscreen'),
  spotlightBack: $('spotlight-back'),

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
  selfAudioTest: $('self-audio-test'),
  sendDiagnostics: $('send-diagnostics'),

  screenPickerModal: $('screen-picker-modal'),
  closeScreenPicker: $('close-screen-picker'),
  screenSourceGrid: $('screen-source-grid'),

  updateBanner: $('update-banner'),
  updateBannerText: $('update-banner-text'),
  updateBannerAction: $('update-banner-action'),
  updateBannerDismiss: $('update-banner-dismiss'),

  errorBanner: $('error-banner'),
  errorBannerText: $('error-banner-text'),
  errorBannerDismiss: $('error-banner-dismiss'),
};

function showErrorBanner(text) {
  el.errorBannerText.textContent = text;
  el.errorBanner.classList.remove('hidden');
}
el.errorBannerDismiss.addEventListener('click', () => el.errorBanner.classList.add('hidden'));

/* ---------- persisted settings ---------- */
const DEFAULT_SETTINGS = {
  server: 'https://voicechat-signaling.onrender.com',
  password: '',
  name: '',
  inputDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  inputGainPct: 100,
  voiceMode: 'always', // always | vad | ptt
  vadSensitivity: 55,
  pttKeyCode: 'Space',
  pttKeyLabel: 'Espaco',
  globalMuteAccelerator: 'CommandOrControl+Shift+M',
  globalMuteLabel: 'Ctrl+Shift+M',
  includeSystemAudio: false,
  schemaVersion: 2,
};

// v2: o modo de voz padrao mudou de "ativado por voz" pra "sempre
// transmitindo" (o limiar do VAD podia deixar o microfone mudo em
// silencio sem ninguem perceber). Quem ja tinha configuracoes salvas de
// uma versao anterior tem o modo migrado uma unica vez aqui.
function migrateSettings(loaded) {
  if (!loaded.schemaVersion || loaded.schemaVersion < 2) {
    loaded.voiceMode = 'always';
  }
  loaded.schemaVersion = DEFAULT_SETTINGS.schemaVersion;
  return loaded;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('voicechat.settings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    return migrateSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  localStorage.setItem('voicechat.settings', JSON.stringify(settings));
}

const settings = loadSettings();

// Identidade estavel por instalacao — sobrevive a reconexoes (diferente do
// id de socket, que muda a cada vez) e e o que permite mandar mensagem
// privada pra alguem mesmo que ele troque de canal ou reconecte.
function ensureClientUid() {
  let uid = localStorage.getItem('voicechat.uid');
  if (!uid) {
    uid = (crypto.randomUUID && crypto.randomUUID()) || `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('voicechat.uid', uid);
  }
  return uid;
}

/* ---------- global state ---------- */
const state = {
  socket: null,
  selfId: null,
  uid: ensureClientUid(),
  displayName: '',
  currentChannel: null,
  channels: [], // nomes dos canais publicos do grupo
  dms: [], // [{name, otherUid, otherName}]
  groupMembers: new Map(), // socketId -> {id, uid, name, channel}
  peers: new Map(), // id -> peerState (so quem esta no MESMO canal que eu)
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
  focusedTileId: null,
};

function makePeerState(id, name) {
  return {
    id,
    name,
    pc: null,
    polite: false,
    makingOffer: false,
    ignoreOffer: false,
    trackMeta: new Map(), // mid -> kind (kind anunciado pelo lado remoto)
    pendingTracks: new Map(), // mid -> MediaStreamTrack (faixas recebidas via ontrack)
    pendingKindBySender: new Map(), // RTCRtpSender -> kind (aguardando o mid ficar disponivel pra anunciar)
    micAudioEl: null,
    micTrack: null, // MediaStreamTrack cru recebido do outro lado, guardado so pro diagnostico (.muted/.readyState)
    micAnalyser: null, // so pra medir nivel (indicador de "falando"), fora do caminho de reproducao
    micSourceNode: null,
    volume: 1,
    speaking: false,
    micMuted: false,
    cameraOn: false,
    screenOn: false,
    connState: 'new', // new | connecting | connected | disconnected | failed | closed
    audioReceived: false, // true assim que a faixa de microfone remota e reconhecida e conectada a um <audio>
    remoteTrackEverReceived: false, // true assim que QUALQUER faixa remota chega (ontrack), mesmo antes de sabermos o tipo
  };
}

/* =========================================================================
   LOGIN
   ========================================================================= */

el.loginServer.value = settings.server;
el.loginPassword.value = settings.password;
el.loginName.value = settings.name;

async function attemptLogin({ server, password, name }) {
  el.loginError.textContent = '';
  el.loginSubmit.disabled = true;
  el.loginSubmit.textContent = 'Conectando...';
  try {
    await connectToServer({ server, password, name });
  } catch (err) {
    el.loginError.textContent = err && err.message ? err.message : 'Falha ao conectar.';
    el.loginSubmit.disabled = false;
    el.loginSubmit.textContent = 'Entrar';
  }
}

el.loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  attemptLogin({
    server: el.loginServer.value.trim(),
    password: el.loginPassword.value,
    name: el.loginName.value.trim(),
  });
});

el.loginForgetLink.addEventListener('click', (e) => {
  e.preventDefault();
  settings.password = '';
  settings.name = '';
  saveSettings();
  el.loginPassword.value = '';
  el.loginName.value = '';
  el.loginSwitchAccount.classList.add('hidden');
  el.loginError.textContent = '';
  el.loginName.focus();
});

// Se ja tem senha+nome salvos, conecta sozinho — sem passar pela tela toda
// vez, igual um app que "lembra" de voce.
if (settings.password && settings.name) {
  el.loginSwitchAccount.classList.remove('hidden');
  attemptLogin({
    server: el.loginServer.value.trim(),
    password: settings.password,
    name: settings.name,
  });
}

function connectToServer({ server, password, name }) {
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
      socket.emit('join-group', { password, name, uid: state.uid });
    });

    socket.on('join-error', ({ message }) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimeout);
      socket.close();
      reject(new Error(message || 'Erro ao entrar no grupo.'));
    });

    socket.on('joined-group', async ({ selfId, uid, members, channels, dms }) => {
      if (settled) return;
      settled = true;
      clearTimeout(failTimeout);

      state.socket = socket;
      state.selfId = selfId;
      state.uid = uid;
      state.displayName = name;
      state.channels = channels;
      state.dms = dms;
      state.groupMembers = new Map(members.map((m) => [m.id, m]));

      settings.server = server;
      settings.password = password;
      settings.name = name;
      saveSettings();

      registerSocketHandlers(socket);
      await enterRoomUI();
      renderChannelList();
      renderDmList();
      renderMemberList();

      try {
        await ensureMicPipeline();
      } catch (err) {
        const msg = 'Nao foi possivel acessar o microfone: ' + (err && err.message ? err.message : err) +
          '. Ninguem vai te ouvir. Verifique as permissoes de microfone do Windows (Configuracoes -> Privacidade -> Microfone) para o VoiceChat.';
        pushSystemMessage(msg);
        showErrorBanner(msg);
      }

      switchChannel(channels[0] || 'Geral');
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
  // --- presenca do grupo (todo mundo, independente do canal) ---
  socket.on('member-joined', ({ id, uid, name }) => {
    state.groupMembers.set(id, { id, uid, name, channel: null });
    renderMemberList();
    pushSystemMessage(`${name} entrou no grupo.`);
  });

  socket.on('member-left', ({ id }) => {
    const m = state.groupMembers.get(id);
    state.groupMembers.delete(id);
    renderMemberList();
    renderChannelList();
    if (m) pushSystemMessage(`${m.name} saiu do grupo.`);
  });

  socket.on('member-channel-changed', ({ id, channel }) => {
    const m = state.groupMembers.get(id);
    if (m) m.channel = channel;
    renderMemberList();
    renderChannelList();
  });

  socket.on('channel-created', ({ name }) => {
    if (!state.channels.includes(name)) state.channels.push(name);
    renderChannelList();
  });

  socket.on('dm-ready', ({ name, otherUid, otherName }) => {
    if (!state.dms.find((d) => d.name === name)) state.dms.push({ name, otherUid, otherName });
    renderDmList();
    if (awaitingDmSwitch) {
      awaitingDmSwitch = false;
      switchChannel(name);
    } else {
      pushSystemMessage(`${otherName} quer conversar em particular — veja em "Conversas privadas".`);
    }
  });

  // --- canal atual (voz + texto + video, escopado) ---
  socket.on('channel-joined', ({ name, peers }) => {
    state.currentChannel = name;
    for (const p of peers) {
      addPeer(p.id, p.name, /*polite*/ compareIds(state.selfId, p.id));
    }
    updateChannelHeader();
    renderChannelList();
    renderDmList();
    renderMemberList();
    el.chatMessages.innerHTML = '';
  });

  socket.on('peer-joined', ({ id, name }) => {
    addPeer(id, name, compareIds(state.selfId, id));
    pushSystemMessage(`${name} entrou no canal.`);
  });

  socket.on('peer-left', ({ id }) => {
    const peer = state.peers.get(id);
    if (peer) {
      pushSystemMessage(`${peer.name} saiu do canal.`);
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
      announcePendingKinds(peer);
    } catch (err) {
      console.error('negotiation error', err);
    } finally {
      peer.makingOffer = false;
    }
  };

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) state.socket.emit('signal', { to: id, data: { type: 'ice', candidate } });
  };

  pc.onicecandidateerror = (event) => {
    console.warn(`erro no servidor ICE (${event.url || '?'}): ${event.errorCode} ${event.errorText || ''}`);
  };

  pc.onconnectionstatechange = () => {
    peer.connState = pc.connectionState;
    renderMemberList();
    // se cair, tenta reconectar reiniciando o ICE em vez de esperar para
    // sempre por uma reconexao que talvez nunca venha sozinha
    if (pc.connectionState === 'failed') {
      try { pc.restartIce(); } catch (err) { console.warn('restartIce falhou', err); }
    }
  };

  pc.ontrack = (event) => {
    const track = event.track;
    const mid = event.transceiver && event.transceiver.mid;
    peer.remoteTrackEverReceived = true;
    if (mid == null) {
      // mid ainda nao disponivel (raro); sem ele nao da pra casar com o
      // metadado do tipo (mic/camera/tela) recebido do outro lado.
      console.warn('faixa remota chegou sem mid atribuido ainda', track.kind);
      return;
    }
    peer.pendingTracks.set(mid, track);
    track.addEventListener('ended', () => handleRemoteTrackEnded(peer, mid));
    tryResolvePeerTrack(peer, mid);
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

const TRACK_MAX_BITRATE = { camera: 1_800_000, screen: 3_500_000, mic: 64_000 };

function attachTrackToPeer(peer, track, kind) {
  const sender = peer.pc.addTrack(track, new MediaStream([track]));
  peer._senders = peer._senders || {};
  peer._senders[kind] = sender;
  // o "mid" (identificador da linha m= na negociacao) so fica disponivel
  // depois que uma SDP local for gerada — so entao da pra avisar o outro
  // lado com seguranca de qual "mid" corresponde a qual tipo de faixa.
  // (o id da MediaStreamTrack NAO e garantido ser o mesmo dos dois lados
  // da conexao, entao nao pode ser usado pra essa correlacao.)
  peer.pendingKindBySender.set(sender, kind);
  if (TRACK_MAX_BITRATE[kind]) applySenderBitrate(sender, TRACK_MAX_BITRATE[kind]);
}

function announcePendingKinds(peer) {
  if (!peer.pendingKindBySender.size) return;
  for (const transceiver of peer.pc.getTransceivers()) {
    if (transceiver.mid == null) continue;
    const kind = peer.pendingKindBySender.get(transceiver.sender);
    if (kind === undefined) continue;
    peer.pendingKindBySender.delete(transceiver.sender);
    state.socket.emit('signal', { to: peer.id, data: { type: 'track-meta', mid: transceiver.mid, kind } });
  }
}

async function applySenderBitrate(sender, maxBitrate) {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    await sender.setParameters(params);
  } catch (err) {
    console.warn('nao foi possivel ajustar o bitrate do video', err);
  }
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
    announcePendingKinds(peer);
  } else if (data.type === 'ice') {
    try {
      await peer.pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!peer.ignoreOffer) console.error('ICE add error', err);
    }
  } else if (data.type === 'track-meta') {
    peer.trackMeta.set(data.mid, data.kind);
    tryResolvePeerTrack(peer, data.mid);
  } else if (data.type === 'track-removed') {
    if (data.kind === 'camera') { peer.cameraOn = false; removeVideoTile(`${peer.id}-camera`); renderMemberList(); }
    else if (data.kind === 'screen') { peer.screenOn = false; removeVideoTile(`${peer.id}-screen`); renderMemberList(); }
    else if (data.kind === 'screen-audio' && peer.screenAudioEl) {
      peer.screenAudioEl.pause();
      peer.screenAudioEl.remove();
      peer.screenAudioEl = null;
    }
  }
}

function tryResolvePeerTrack(peer, mid) {
  const kind = peer.trackMeta.get(mid);
  const track = peer.pendingTracks.get(mid);
  if (!kind || !track) return;
  peer.pendingTracks.delete(mid);

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

function handleRemoteTrackEnded(peer, mid) {
  const kind = peer.trackMeta.get(mid);
  peer.trackMeta.delete(mid);
  peer.pendingTracks.delete(mid);
  if (kind === 'camera') { peer.cameraOn = false; removeVideoTile(`${peer.id}-camera`); renderMemberList(); }
  if (kind === 'screen') { peer.screenOn = false; removeVideoTile(`${peer.id}-screen`); renderMemberList(); }
}

/* ---------- remote mic audio graph (per-user volume + speaking meter + output device) ---------- */
function attachRemoteMicTrack(peer, track) {
  const stream = new MediaStream([track]);

  // Toca o audio DIRETO no elemento, sem passar pelo grafo do Web Audio
  // (ganho -> analisador -> destino -> novo elemento). Esse era o mesmo
  // padrao usado pelo "testar meu audio", que sempre funcionou; a
  // indirecao extra do Web Audio era uma camada a mais que podia falhar
  // silenciosamente sem deixar rastro nas estatisticas de rede.
  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  audioEl.srcObject = stream;
  audioEl.volume = state.deafened ? 0 : Math.min(1, peer.volume);
  if (settings.outputDeviceId && audioEl.setSinkId) {
    audioEl.setSinkId(settings.outputDeviceId).catch(() => {});
  }
  document.body.appendChild(audioEl);
  audioEl.play().catch((err) => console.warn('autoplay do audio remoto bloqueado', err));

  // Analisador separado, so pra medir nivel (indicador de "falando") —
  // nao faz parte do caminho de reproducao, entao nao pode silenciar nada.
  ensureAudioCtx();
  const sourceNode = state.audioCtx.createMediaStreamSource(stream);
  const analyser = state.audioCtx.createAnalyser();
  analyser.fftSize = 512;
  sourceNode.connect(analyser);

  peer.micSourceNode = sourceNode;
  peer.micAnalyser = analyser;
  peer.micAudioEl = audioEl;
  peer.micTrack = track;
  peer.audioReceived = true;
  renderMemberList();

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
      renderChannelList();
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
    tile.addEventListener('click', () => toggleTileFocus(tileId));
    el.videoGrid.appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('.tile-label').textContent = label;
  updateStageLayout();
}

function removeVideoTile(tileId) {
  const tile = document.getElementById(`tile-${tileId}`);
  if (tile) tile.remove();
  if (state.focusedTileId === tileId) state.focusedTileId = null;
  updateStageLayout();
}

/* ---------- modo destaque (clicar numa miniatura pra focar, estilo Discord) ---------- */
function toggleTileFocus(tileId) {
  state.focusedTileId = state.focusedTileId === tileId ? null : tileId;
  updateStageLayout();
}

function updateStageLayout() {
  const allTiles = Array.from(el.videoGrid.children).concat(
    Array.from(el.videoFocus.children),
    Array.from(el.videoStrip.children)
  );
  const focusedTile = state.focusedTileId
    ? allTiles.find((t) => t.id === `tile-${state.focusedTileId}`)
    : null;

  if (focusedTile) {
    el.videoGrid.classList.add('hidden');
    el.videoSpotlight.classList.remove('hidden');
    el.videoFocus.appendChild(focusedTile);
    for (const tile of allTiles) {
      if (tile !== focusedTile) el.videoStrip.appendChild(tile);
    }
  } else {
    state.focusedTileId = null;
    el.videoSpotlight.classList.add('hidden');
    el.videoGrid.classList.remove('hidden');
    for (const tile of allTiles) el.videoGrid.appendChild(tile);
  }

  const totalTiles = allTiles.length;
  el.emptyStageHint.classList.toggle('hidden', totalTiles > 0);
}

el.spotlightBack.addEventListener('click', () => {
  state.focusedTileId = null;
  updateStageLayout();
});
el.spotlightFullscreen.addEventListener('click', () => {
  const video = el.videoFocus.querySelector('video');
  if (video) video.requestFullscreen().catch(() => {});
});

/* =========================================================================
   SONS DE INTERFACE (mute/desmute, ensurdecer, camera, tela)
   ========================================================================= */

const UI_CHIMES = {
  mute: [523, 349],
  unmute: [349, 523],
  deafenOn: [440, 277],
  deafenOff: [277, 440],
  cameraOn: [466, 622],
  cameraOff: [622, 466],
  screenOn: [415, 554, 698],
  screenOff: [698, 554, 415],
};

function ensureUiAudioCtx() {
  if (!state.uiAudioCtx) state.uiAudioCtx = new AudioContext();
  if (state.uiAudioCtx.state === 'suspended') state.uiAudioCtx.resume();
  return state.uiAudioCtx;
}

function playUiTone(ctx, freq, startTime, duration) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.18, startTime + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.02);
}

function playUiSound(name) {
  const sequence = UI_CHIMES[name];
  if (!sequence) return;
  const ctx = ensureUiAudioCtx();
  const now = ctx.currentTime;
  const step = 0.09;
  sequence.forEach((freq, i) => playUiTone(ctx, freq, now + i * step, 0.11));
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
    // ja tinha um track antes (troca de dispositivo/configuracao): substitui
    // em cada peer connection existente, sem precisar renegociar.
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders.mic;
      if (sender) sender.replaceTrack(newProcessedTrack).catch(() => {});
    }
    newProcessedTrack.enabled = state.processedMicTrack.enabled;
  } else {
    // primeira vez que o microfone fica pronto: pode ja existir gente na
    // sala cujas conexoes foram criadas antes do getUserMedia terminar —
    // anexa o track nelas agora, senao ninguem ouve nosso audio.
    for (const peer of state.peers.values()) {
      if (!peer._senders || !peer._senders.mic) attachTrackToPeer(peer, newProcessedTrack, 'mic');
    }
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
    playUiSound('cameraOn');
  } catch (err) {
    const msg = 'Nao foi possivel acessar a camera: ' + (err && err.message ? err.message : err);
    pushSystemMessage(msg);
    showErrorBanner(msg);
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
      // o evento 'ended' da faixa remota nao dispara de forma confiavel so
      // por causa de uma renegociacao removendo o track — por isso avisamos
      // explicitamente o outro lado, ao inves de depender so disso (era a
      // causa da imagem congelada ficando presa na tela depois de parar).
      state.socket.emit('signal', { to: peer.id, data: { type: 'track-removed', kind: 'camera' } });
    }
    playUiSound('cameraOff');
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
    track.contentHint = 'detail'; // pede ao encoder pra priorizar nitidez (texto/UI) sobre movimento
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
    playUiSound('screenOn');
  } catch (err) {
    const msg = 'Nao foi possivel compartilhar a tela: ' + (err && err.message ? err.message : err);
    pushSystemMessage(msg);
    showErrorBanner(msg);
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
      state.socket.emit('signal', { to: peer.id, data: { type: 'track-removed', kind: 'screen' } });
    }
    playUiSound('screenOff');
  }
  if (state.screenAudioTrack) {
    state.screenAudioTrack.stop();
    for (const peer of state.peers.values()) {
      const sender = peer._senders && peer._senders['screen-audio'];
      if (sender) {
        peer.pc.removeTrack(sender);
        delete peer._senders['screen-audio'];
      }
      state.socket.emit('signal', { to: peer.id, data: { type: 'track-removed', kind: 'screen-audio' } });
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

  // Mostra todo mundo do grupo, nao so quem esta no mesmo canal — quem
  // esta no meu canal ganha os controles de voz completos; o resto so
  // aparece com nome + canal onde esta + botao de conversa privada.
  for (const gm of state.groupMembers.values()) {
    const peer = state.peers.get(gm.id);
    if (peer) {
      el.memberList.appendChild(buildMemberRow({
        id: peer.id,
        rowId: `member-${peer.id}`,
        name: peer.name,
        uid: gm.uid,
        micMuted: !!peer.micMuted,
        cameraOn: !!peer.cameraOn,
        screenOn: !!peer.screenOn,
        speaking: !!peer.speaking,
        isSelf: false,
        peer,
      }));
    } else {
      el.memberList.appendChild(buildOtherChannelMemberRow(gm));
    }
  }
}

function channelDisplayLabel(channelName) {
  if (!channelName) return 'sem canal';
  if (channelName.startsWith('dm:')) return 'em conversa privada';
  return `em #${channelName}`;
}

function buildOtherChannelMemberRow(gm) {
  const row = document.createElement('div');
  row.className = 'member other-channel';

  const avatar = document.createElement('div');
  avatar.className = 'member-avatar';
  avatar.textContent = (gm.name || '?').trim().slice(0, 2).toUpperCase();

  const nameCol = document.createElement('div');
  nameCol.className = 'member-name-col';
  const nameEl = document.createElement('div');
  nameEl.className = 'member-name';
  nameEl.textContent = gm.name;
  const statusEl = document.createElement('div');
  statusEl.className = 'member-status';
  statusEl.textContent = channelDisplayLabel(gm.channel);
  nameCol.appendChild(nameEl);
  nameCol.appendChild(statusEl);

  row.appendChild(avatar);
  row.appendChild(nameCol);

  if (gm.uid !== state.uid) {
    const dmBtn = document.createElement('button');
    dmBtn.type = 'button';
    dmBtn.className = 'member-dm-btn';
    dmBtn.textContent = 'Privado';
    dmBtn.addEventListener('click', () => startPrivateChat(gm.uid));
    row.appendChild(dmBtn);
  }
  return row;
}

/* =========================================================================
   CANAIS E CONVERSAS PRIVADAS
   ========================================================================= */

function channelOccupants(channelName) {
  const list = [];
  if (state.currentChannel === channelName) {
    list.push({ name: `${state.displayName} (voce)`, speaking: false });
  }
  for (const gm of state.groupMembers.values()) {
    if (gm.channel !== channelName) continue;
    const peer = state.peers.get(gm.id);
    list.push({ name: gm.name, speaking: !!(peer && peer.speaking) });
  }
  return list;
}

function renderChannelList() {
  el.channelList.innerHTML = '';
  for (const name of state.channels) {
    const wrap = document.createElement('div');
    wrap.className = 'channel-item-wrap';

    const item = document.createElement('div');
    item.className = 'channel-item' + (name === state.currentChannel ? ' active' : '');
    item.textContent = `🔊 ${name}`;
    item.addEventListener('click', () => switchChannel(name));
    wrap.appendChild(item);

    const occupants = channelOccupants(name);
    if (occupants.length) {
      const occRow = document.createElement('div');
      occRow.className = 'channel-occupants';
      for (const occ of occupants) {
        const occEl = document.createElement('div');
        occEl.className = 'channel-occupant' + (occ.speaking ? ' speaking' : '');
        const av = document.createElement('div');
        av.className = 'occ-avatar';
        av.textContent = occ.name.trim().slice(0, 2).toUpperCase();
        const nm = document.createElement('span');
        nm.textContent = occ.name;
        occEl.appendChild(av);
        occEl.appendChild(nm);
        occRow.appendChild(occEl);
      }
      wrap.appendChild(occRow);
    }

    el.channelList.appendChild(wrap);
  }
}

function renderDmList() {
  el.dmList.innerHTML = '';
  for (const dm of state.dms) {
    const item = document.createElement('div');
    item.className = 'channel-item' + (dm.name === state.currentChannel ? ' active' : '');
    item.textContent = `🔒 ${dm.otherName || 'privado'}`;
    item.addEventListener('click', () => switchChannel(dm.name));
    el.dmList.appendChild(item);
  }
}

function updateChannelHeader() {
  let label;
  if (state.currentChannel && state.currentChannel.startsWith('dm:')) {
    const dm = state.dms.find((d) => d.name === state.currentChannel);
    label = `🔒 ${dm ? dm.otherName : 'Privado'}`;
  } else {
    label = `# ${state.currentChannel || ''}`;
  }
  el.channelHeader.textContent = label;
  el.chatHeaderTitle.textContent = label;
}

function switchChannel(name) {
  if (!name || !state.socket || name === state.currentChannel) return;
  if (state.currentChannel) state.socket.emit('leave-channel');
  for (const id of Array.from(state.peers.keys())) removePeer(id);
  state.peers.clear();
  state.socket.emit('join-channel', { name });
}

let awaitingDmSwitch = false;
function startPrivateChat(targetUid) {
  awaitingDmSwitch = true;
  state.socket.emit('create-dm', { targetUid });
}

el.addChannelBtn.addEventListener('click', () => {
  el.addChannelForm.classList.toggle('hidden');
  if (!el.addChannelForm.classList.contains('hidden')) el.addChannelInput.focus();
});
el.addChannelForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = el.addChannelInput.value.trim();
  if (!name) return;
  state.socket.emit('create-channel', { name });
  el.addChannelInput.value = '';
  el.addChannelForm.classList.add('hidden');
});

const CONN_STATE_LABEL = {
  new: 'aguardando conexao...',
  connecting: 'conectando...',
  connected: 'conectado',
  disconnected: 'reconectando...',
  failed: 'falha na conexao',
  closed: 'encerrado',
};

function buildMemberRow({ id, rowId, name, uid, micMuted, cameraOn, screenOn, speaking, isSelf, peer }) {
  const row = document.createElement('div');
  row.className = 'member' + (speaking ? ' speaking' : '');
  row.id = rowId;

  const avatar = document.createElement('div');
  avatar.className = 'member-avatar';
  avatar.textContent = (name || '?').trim().slice(0, 2).toUpperCase();

  const nameCol = document.createElement('div');
  nameCol.className = 'member-name-col';

  const nameEl = document.createElement('div');
  nameEl.className = 'member-name';
  nameEl.textContent = name;
  nameCol.appendChild(nameEl);

  if (!isSelf && peer) {
    const statusEl = document.createElement('div');
    const label = CONN_STATE_LABEL[peer.connState] || peer.connState;
    statusEl.className = 'member-status' + (peer.connState === 'connected' ? ' ok' : '') + (peer.connState === 'failed' ? ' err' : '');
    statusEl.textContent = peer.connState === 'connected'
      ? (peer.audioReceived ? label + ' · recebendo audio' : label + ' · sem audio ainda')
      : label;
    nameCol.appendChild(statusEl);
  }

  const icons = document.createElement('div');
  icons.className = 'member-icons';
  icons.textContent = [
    micMuted ? '🔇' : '',
    cameraOn ? '📷' : '',
    screenOn ? '🖥️' : '',
  ].filter(Boolean).join(' ');

  row.appendChild(avatar);
  row.appendChild(nameCol);
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
      // <audio>.volume so aceita 0..1 (sem "boost" acima de 100%); a
      // troca pra reproducao direta abriu mao do ganho do Web Audio.
      if (peer.micAudioEl) peer.micAudioEl.volume = state.deafened ? 0 : Math.min(1, peer.volume);
    });
    volWrap.appendChild(range);
    row.appendChild(volWrap);
  }

  if (!isSelf && uid) {
    const dmBtn = document.createElement('button');
    dmBtn.type = 'button';
    dmBtn.className = 'member-dm-btn';
    dmBtn.title = 'Conversar em particular';
    dmBtn.textContent = '💬';
    dmBtn.addEventListener('click', () => startPrivateChat(uid));
    row.appendChild(dmBtn);
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
  playUiSound(state.manualMicMuted ? 'mute' : 'unmute');
});

el.toggleDeafen.addEventListener('click', () => {
  state.deafened = !state.deafened;
  el.toggleDeafen.classList.toggle('active', state.deafened);
  for (const peer of state.peers.values()) {
    if (peer.micAudioEl) peer.micAudioEl.volume = state.deafened ? 0 : Math.min(1, peer.volume);
  }
  applyMicEnabledState();
  state.socket.emit('state', { deafened: state.deafened, micMuted: state.manualMicMuted || state.deafened });
  playUiSound(state.deafened ? 'deafenOn' : 'deafenOff');
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
el.closeSettings.addEventListener('click', () => {
  el.settingsModal.classList.add('hidden');
  stopSelfAudioTest();
});

/* ---------- teste de audio local (ouvir a si mesmo) ---------- */
let selfTestAudioEl = null;

function startSelfAudioTest() {
  if (!state.micDestNode) {
    pushSystemMessage('O microfone ainda nao esta pronto (entre no grupo primeiro).');
    return;
  }
  ensureAudioCtx();
  selfTestAudioEl = document.createElement('audio');
  selfTestAudioEl.autoplay = true;
  selfTestAudioEl.srcObject = state.micDestNode.stream;
  if (settings.outputDeviceId && selfTestAudioEl.setSinkId) {
    selfTestAudioEl.setSinkId(settings.outputDeviceId).catch(() => {});
  }
  document.body.appendChild(selfTestAudioEl);
  selfTestAudioEl.play().catch((err) => console.warn('autoplay do teste de audio bloqueado', err));
  el.selfAudioTest.classList.add('active');
  el.selfAudioTest.textContent = '⏹ Parar teste (voce deve se ouvir agora)';
}

function stopSelfAudioTest() {
  if (selfTestAudioEl) {
    selfTestAudioEl.pause();
    selfTestAudioEl.remove();
    selfTestAudioEl = null;
  }
  el.selfAudioTest.classList.remove('active');
  el.selfAudioTest.textContent = '🔊 Testar meu audio (ouvir a si mesmo)';
}

el.selfAudioTest.addEventListener('click', () => {
  if (selfTestAudioEl) stopSelfAudioTest();
  else startSelfAudioTest();
});

/* ---------- diagnostico tecnico (pra investigar problema de audio/video) ---------- */
// "audio_dele_reconhecido=true" so confirma que a faixa foi identificada como
// microfone e que um <audio> foi criado e mandado tocar — nao confirma que
// algum byte chegou pela rede nem que o play() realmente funcionou. Por isso
// o diagnostico le getStats() (contagem real de pacotes/bytes vindos da rede,
// rota usada, nivel de audio) e o estado do elemento de audio local, pra
// distinguir "nao chegou nada pela rede" de "chegou, mas nao esta tocando".
async function summarizePeerStats(peer) {
  const out = {
    candidateType: '-', packetsSent: '-', packetsReceived: '-',
    packetsLost: '-', bytesReceived: 0, jitter: '-', audioLevel: '-', localAudioLevel: '-',
  };
  try {
    const stats = await peer.pc.getStats();
    let transportId = null;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) transportId = r.selectedCandidatePairId;
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.packetsSent = r.packetsSent ?? '-';
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        out.packetsReceived = r.packetsReceived ?? '-';
        out.packetsLost = r.packetsLost ?? '-';
        out.bytesReceived = r.bytesReceived || 0;
        out.jitter = r.jitter != null ? r.jitter.toFixed(3) + 's' : '-';
        if (typeof r.audioLevel === 'number') out.audioLevel = r.audioLevel.toFixed(3);
      }
      // media-source = nivel do audio capturado ANTES de ser enviado, direto
      // do microfone real — se isso ficar sempre em 0 mesmo falando, o
      // problema e na captura, nao na rede nem na reproducao.
      if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') {
        out.localAudioLevel = r.audioLevel.toFixed(3);
      }
    });
    if (transportId) {
      const pair = stats.get(transportId);
      if (pair && pair.state === 'succeeded') {
        const localCand = stats.get(pair.localCandidateId);
        const remoteCand = stats.get(pair.remoteCandidateId);
        out.candidateType = `local=${localCand?.candidateType || '?'} remoto=${remoteCand?.candidateType || '?'}`;
      }
    }
  } catch (err) {
    out.error = String(err && err.message ? err.message : err);
  }
  return out;
}

el.sendDiagnostics.addEventListener('click', async () => {
  el.sendDiagnostics.disabled = true;
  try {
    const lines = [];
    lines.push('--- Diagnostico VoiceChat ---');
    lines.push(`Canal: ${state.currentChannel || '-'} | Meu ID: ${state.selfId || '-'} | Meu uid: ${state.uid} | Ensurdecido: ${state.deafened}`);
    lines.push(`Microfone local: ${state.processedMicTrack ? (state.processedMicTrack.enabled ? 'capturando e habilitado' : 'capturado mas DESABILITADO (mutado ou modo de voz nao ativou)') : 'NAO INICIALIZADO (getUserMedia falhou ou nao rodou)'}`);
    lines.push(`AudioContext de reproducao: ${state.audioCtx ? state.audioCtx.state : 'nao criado ainda'}`);
    if (!state.peers.size) lines.push('Ninguem mais neste canal.');
    for (const peer of state.peers.values()) {
      const micSender = peer._senders && peer._senders.mic;
      const rtcStats = await summarizePeerStats(peer);
      lines.push(
        `[${peer.name}] conexao=${peer.connState} ice=${peer.pc.iceConnectionState} sinalizacao=${peer.pc.signalingState} volume=${peer.volume} | ` +
        `enviando_meu_mic_pra_ele=${!!(micSender && micSender.track)} | recebi_alguma_faixa_dele=${peer.remoteTrackEverReceived} | ` +
        `audio_dele_reconhecido=${peer.audioReceived} | faixas_pendentes=${peer.pendingTracks.size} metadados_recebidos=${peer.trackMeta.size}`
      );
      if (peer.micTrack) {
        lines.push(
          `   faixa de audio dele: estado=${peer.micTrack.readyState} mutada_pela_rede=${peer.micTrack.muted} | ` +
          `elemento de audio: ${peer.micAudioEl ? (peer.micAudioEl.paused ? 'PAUSADO (nao esta tocando)' : 'tocando') : 'nao criado'}`
        );
      }
      lines.push(
        `   rede: rota=${rtcStats.candidateType} | pacotes_enviados=${rtcStats.packetsSent} pacotes_recebidos=${rtcStats.packetsReceived} ` +
        `perdidos=${rtcStats.packetsLost} bytes_recebidos=${rtcStats.bytesReceived} jitter=${rtcStats.jitter} nivel_audio_recebido=${rtcStats.audioLevel} | ` +
        `nivel_do_MEU_mic_capturado=${rtcStats.localAudioLevel}` +
        (rtcStats.error ? ` | erro_getStats=${rtcStats.error}` : '')
      );
      if (rtcStats.bytesReceived === 0) {
        lines.push('   -> NENHUM byte de audio chegou pela rede ainda (mesmo com a faixa reconhecida). Provavel falha no relay TURN, nao bug do app.');
      }
    }
    lines.push('(fale alguma coisa por uns 5s antes de mandar, pra os numeros nao ficarem tudo zero)');
    pushSystemMessage(lines.join('\n'));
    el.chatPanel.classList.remove('hidden');
  } finally {
    el.sendDiagnostics.disabled = false;
  }
});

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

async function enterRoomUI() {
  el.loginScreen.classList.add('hidden');
  el.mainScreen.classList.remove('hidden');
  el.roomName.textContent = 'Grupo';
  setConnectionStatus('conectado', 'ok');
  renderMemberList();
  updateStageLayout();
  await registerGlobalMuteHotkey();
}

window.addEventListener('beforeunload', () => {
  if (state.socket) state.socket.close();
});

/* =========================================================================
   ATUALIZACAO AUTOMATICA
   ========================================================================= */

function showUpdateBanner(text, { showAction } = {}) {
  el.updateBannerText.textContent = text;
  el.updateBannerAction.classList.toggle('hidden', !showAction);
  el.updateBanner.classList.remove('hidden');
}

el.updateBannerDismiss.addEventListener('click', () => el.updateBanner.classList.add('hidden'));
el.updateBannerAction.addEventListener('click', () => {
  if (window.voicechat) window.voicechat.installUpdateNow();
});

if (window.voicechat && window.voicechat.onUpdateStatus) {
  window.voicechat.onUpdateStatus(({ status, version, percent, message }) => {
    if (status === 'available') {
      showUpdateBanner(`Baixando atualizacao (v${version})...`);
    } else if (status === 'downloading') {
      showUpdateBanner(`Baixando atualizacao... ${percent}%`);
    } else if (status === 'downloaded') {
      showUpdateBanner(`Atualizacao v${version} pronta.`, { showAction: true });
    } else if (status === 'error') {
      console.warn('update error', message);
    }
  });
}
