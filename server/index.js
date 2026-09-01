const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS_PER_GROUP = parseInt(process.env.MAX_PEERS_PER_ROOM || '24', 10);

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

// A "senha do grupo" e a propria identidade do grupo: o hash dela e a
// chave. Nao existe mais um "nome de sala" digitado — todo mundo com a
// mesma senha cai automaticamente no mesmo grupo, que ja nasce com um
// canal "Geral".
//
// groups: Map<groupId, {
//   members: Map<socketId, { uid, name, channel: string|null }>,
//   channels: Map<channelName, { isDm: boolean, participants?: [uid, uid] }>,
// }>
const groups = new Map();

function hashPassword(pw) {
  return crypto.createHash('sha256').update(String(pw || '')).digest('hex');
}

function sanitizeName(name) {
  return String(name || 'Anonimo').slice(0, 32).trim() || 'Anonimo';
}

function sanitizeUid(uid) {
  return String(uid || '').trim().slice(0, 64);
}

function sanitizeChannelName(name) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean || clean.startsWith('dm:')) return null;
  return clean;
}

function channelRoomName(groupId, channelName) {
  return `group:${groupId}:channel:${channelName}`;
}

function lobbyRoomName(groupId) {
  return `group:${groupId}`;
}

function leaveCurrentChannel(socket) {
  const groupId = socket.data.groupId;
  const channelName = socket.data.channel;
  if (!groupId || !channelName) return;
  const roomName = channelRoomName(groupId, channelName);
  socket.leave(roomName);
  socket.to(roomName).emit('peer-left', { id: socket.id });
  socket.data.channel = null;
  const group = groups.get(groupId);
  const member = group && group.members.get(socket.id);
  if (member) member.channel = null;
  socket.to(lobbyRoomName(groupId)).emit('member-channel-changed', { id: socket.id, channel: null });
}

io.on('connection', (socket) => {
  socket.data.groupId = null;
  socket.data.uid = null;
  socket.data.name = null;
  socket.data.channel = null;

  socket.on('join-group', ({ password, name, uid } = {}) => {
    if (socket.data.groupId) {
      socket.emit('join-error', { message: 'Voce ja esta em um grupo.' });
      return;
    }
    const clientUid = sanitizeUid(uid);
    if (!clientUid) {
      socket.emit('join-error', { message: 'Identificador de usuario invalido.' });
      return;
    }
    const groupId = hashPassword(password);
    const displayName = sanitizeName(name);

    let group = groups.get(groupId);
    if (!group) {
      group = { members: new Map(), channels: new Map([['Geral', { isDm: false }]]) };
      groups.set(groupId, group);
    }
    if (group.members.size >= MAX_MEMBERS_PER_GROUP) {
      socket.emit('join-error', { message: 'Grupo cheio.' });
      return;
    }

    socket.data.groupId = groupId;
    socket.data.uid = clientUid;
    socket.data.name = displayName;
    socket.data.micMuted = false;
    socket.data.deafened = false;
    socket.data.cameraOn = false;
    socket.data.screenOn = false;
    socket.join(lobbyRoomName(groupId));
    group.members.set(socket.id, { uid: clientUid, name: displayName, channel: null });

    const members = Array.from(group.members.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, m]) => {
        const s = io.sockets.sockets.get(id);
        return {
          id,
          uid: m.uid,
          name: m.name,
          channel: m.channel,
          micMuted: !!(s && s.data.micMuted),
          deafened: !!(s && s.data.deafened),
          cameraOn: !!(s && s.data.cameraOn),
          screenOn: !!(s && s.data.screenOn),
        };
      });
    const channels = Array.from(group.channels.entries())
      .filter(([, c]) => !c.isDm)
      .map(([channelName]) => channelName);
    const dms = Array.from(group.channels.entries())
      .filter(([, c]) => c.isDm && c.participants.includes(clientUid))
      .map(([channelName, c]) => ({
        name: channelName,
        otherUid: c.participants.find((u) => u !== clientUid),
      }));

    socket.emit('joined-group', { selfId: socket.id, uid: clientUid, members, channels, dms });
    socket.to(lobbyRoomName(groupId)).emit('member-joined', {
      id: socket.id, uid: clientUid, name: displayName,
      micMuted: false, deafened: false, cameraOn: false, screenOn: false,
    });
  });

  socket.on('create-channel', ({ name } = {}) => {
    const groupId = socket.data.groupId;
    if (!groupId) return;
    const group = groups.get(groupId);
    const channelName = sanitizeChannelName(name);
    if (!channelName) {
      socket.emit('join-error', { message: 'Nome de canal invalido.' });
      return;
    }
    if (group.channels.has(channelName)) {
      socket.emit('join-error', { message: 'Ja existe um canal com esse nome.' });
      return;
    }
    group.channels.set(channelName, { isDm: false });
    io.to(lobbyRoomName(groupId)).emit('channel-created', { name: channelName });
  });

  socket.on('join-channel', ({ name } = {}) => {
    const groupId = socket.data.groupId;
    if (!groupId) {
      socket.emit('join-error', { message: 'Entre no grupo primeiro.' });
      return;
    }
    const group = groups.get(groupId);
    const channelName = String(name || '').trim().slice(0, 64);
    if (!group.channels.has(channelName)) {
      socket.emit('join-error', { message: 'Esse canal nao existe (mais).' });
      return;
    }

    leaveCurrentChannel(socket);

    const roomName = channelRoomName(groupId, channelName);
    const existingIds = Array.from(io.sockets.adapter.rooms.get(roomName) || []);
    const peers = existingIds
      .map((id) => {
        const s = io.sockets.sockets.get(id);
        if (!s) return null;
        return {
          id,
          uid: s.data.uid,
          name: s.data.name,
          micMuted: !!s.data.micMuted,
          deafened: !!s.data.deafened,
          cameraOn: !!s.data.cameraOn,
          screenOn: !!s.data.screenOn,
        };
      })
      .filter(Boolean);

    socket.join(roomName);
    socket.data.channel = channelName;
    socket.data.micMuted = false;
    socket.data.deafened = false;
    socket.data.cameraOn = false;
    socket.data.screenOn = false;
    const member = group.members.get(socket.id);
    if (member) member.channel = channelName;

    socket.emit('channel-joined', { name: channelName, peers });
    socket.to(roomName).emit('peer-joined', { id: socket.id, name: socket.data.name, uid: socket.data.uid });
    socket.to(lobbyRoomName(groupId)).emit('member-channel-changed', {
      id: socket.id, channel: channelName,
      micMuted: false, deafened: false, cameraOn: false, screenOn: false,
    });
  });

  socket.on('leave-channel', () => leaveCurrentChannel(socket));

  socket.on('create-dm', ({ targetUid } = {}) => {
    const groupId = socket.data.groupId;
    const myUid = socket.data.uid;
    if (!groupId || !myUid || !targetUid || targetUid === myUid) return;
    const group = groups.get(groupId);
    const pair = [myUid, targetUid].sort();
    const dmName = 'dm:' + pair.join(':');
    if (!group.channels.has(dmName)) {
      group.channels.set(dmName, { isDm: true, participants: pair });
    }
    const targetEntry = Array.from(group.members.entries()).find(([, m]) => m.uid === targetUid);
    socket.emit('dm-ready', {
      name: dmName,
      otherUid: targetUid,
      otherName: targetEntry ? targetEntry[1].name : '',
    });
    if (targetEntry) {
      io.to(targetEntry[0]).emit('dm-ready', { name: dmName, otherUid: myUid, otherName: socket.data.name });
    }
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (!socket.data.groupId || !to) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat', ({ text } = {}) => {
    const channelName = socket.data.channel;
    if (!channelName) return;
    const msg = String(text || '').slice(0, 2000).trim();
    if (!msg) return;
    const roomName = channelRoomName(socket.data.groupId, channelName);
    io.to(roomName).emit('chat', {
      from: socket.id,
      name: socket.data.name,
      text: msg,
      ts: Date.now(),
      channel: channelName,
    });
  });

  socket.on('state', (partial = {}) => {
    const groupId = socket.data.groupId;
    if (!groupId) return;
    const allowed = ['micMuted', 'deafened', 'cameraOn', 'screenOn'];
    for (const key of allowed) {
      if (key in partial) socket.data[key] = !!partial[key];
    }
    // avisa quem esta no MESMO canal (controles de voz completos) e
    // tambem o grupo inteiro (pra mostrar o iconezinho de mutado/camera
    // na lista de canais mesmo pra quem nao esta junto).
    const channelName = socket.data.channel;
    if (channelName) {
      const roomName = channelRoomName(groupId, channelName);
      socket.to(roomName).emit('peer-state', { id: socket.id, ...partial });
    }
    socket.to(lobbyRoomName(groupId)).emit('member-state', { id: socket.id, ...partial });
  });

  socket.on('disconnect', () => {
    const groupId = socket.data.groupId;
    if (!groupId) return;
    leaveCurrentChannel(socket);
    const group = groups.get(groupId);
    if (!group) return;
    group.members.delete(socket.id);
    socket.to(lobbyRoomName(groupId)).emit('member-left', { id: socket.id });
    if (group.members.size === 0) groups.delete(groupId);
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
