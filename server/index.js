const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_PEERS_PER_ROOM = parseInt(process.env.MAX_PEERS_PER_ROOM || '8', 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 15000,
  pingTimeout: 20000,
});

app.get('/', (_req, res) => {
  res.status(200).send('VoiceChat signaling server is running.');
});
app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

// rooms: Map<roomId, { passwordHash: string, peers: Map<socketId, {name}> }>
const rooms = new Map();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw || '')).digest('hex');
}

function sanitizeName(name) {
  return String(name || 'Anonimo').slice(0, 32).trim() || 'Anonimo';
}

function sanitizeRoomId(room) {
  return String(room || '').trim().slice(0, 48);
}

io.on('connection', (socket) => {
  socket.data.roomId = null;

  socket.on('join', ({ room, password, name } = {}) => {
    const roomId = sanitizeRoomId(room);
    const displayName = sanitizeName(name);
    const pwHash = hashPassword(password);

    if (!roomId) {
      socket.emit('join-error', { message: 'Nome da sala invalido.' });
      return;
    }
    if (socket.data.roomId) {
      socket.emit('join-error', { message: 'Voce ja esta em uma sala.' });
      return;
    }

    let roomState = rooms.get(roomId);
    if (!roomState) {
      roomState = { passwordHash: pwHash, peers: new Map() };
      rooms.set(roomId, roomState);
    } else if (roomState.passwordHash !== pwHash) {
      socket.emit('join-error', { message: 'Senha incorreta para esta sala.' });
      return;
    }

    if (roomState.peers.size >= MAX_PEERS_PER_ROOM) {
      socket.emit('join-error', { message: 'Sala cheia.' });
      return;
    }

    const existingPeers = Array.from(roomState.peers.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      micMuted: p.micMuted,
      deafened: p.deafened,
      cameraOn: p.cameraOn,
      screenOn: p.screenOn,
    }));

    roomState.peers.set(socket.id, {
      name: displayName,
      micMuted: false,
      deafened: false,
      cameraOn: false,
      screenOn: false,
    });

    socket.data.roomId = roomId;
    socket.join(roomId);

    socket.emit('joined', { selfId: socket.id, room: roomId, peers: existingPeers });
    socket.to(roomId).emit('peer-joined', { id: socket.id, name: displayName });
  });

  socket.on('signal', ({ to, data } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId || !to) return;
    const roomState = rooms.get(roomId);
    if (!roomState || !roomState.peers.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ text } = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const msg = String(text || '').slice(0, 2000).trim();
    if (!msg) return;
    const roomState = rooms.get(roomId);
    const peer = roomState && roomState.peers.get(socket.id);
    io.to(roomId).emit('chat', {
      from: socket.id,
      name: peer ? peer.name : 'Anonimo',
      text: msg,
      ts: Date.now(),
    });
  });

  socket.on('state', (partial = {}) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const roomState = rooms.get(roomId);
    const peer = roomState && roomState.peers.get(socket.id);
    if (!peer) return;

    const allowed = ['micMuted', 'deafened', 'cameraOn', 'screenOn', 'speaking'];
    for (const key of allowed) {
      if (key in partial) peer[key] = !!partial[key];
    }
    socket.to(roomId).emit('peer-state', { id: socket.id, ...partial });
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const roomState = rooms.get(roomId);
    if (!roomState) return;
    roomState.peers.delete(socket.id);
    socket.to(roomId).emit('peer-left', { id: socket.id });
    if (roomState.peers.size === 0) {
      rooms.delete(roomId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
