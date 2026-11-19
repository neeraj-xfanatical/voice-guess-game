const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room, GameError, CONFIG, RIDDLES } = require('./game');

const PORT = Number(process.env.PORT) || 3000;
const ROOM_IDLE_MINUTES = Number(process.env.ROOM_IDLE_MINUTES) || 30;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TONE_DIR = path.join(__dirname, '..', 'node_modules', 'tone', 'build');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100_000, // audio goes over HTTP, not sockets
  pingInterval: 10_000,
  pingTimeout: 20_000,
});

// Only one room exists at a time.
let room = null;

// ---------------------------------------------------------------- room lifecycle
function broadcastState() {
  if (!room) return;
  for (const m of room.members.values()) {
    if (!m.sockets.size) continue;
    const state = room.stateFor(m);
    for (const s of m.sockets) s.emit('room:state', state);
  }
}

function onMemberRemoved(member, reason) {
  for (const s of member.sockets) {
    s.emit(reason === 'kicked' ? 'room:kicked' : 'room:left');
    setTimeout(() => s.disconnect(true), 200);
  }
  member.sockets.clear();
}

function createRoom(hostName) {
  room = new Room(hostName, { change: broadcastState, removed: onMemberRemoved });
  console.log(`[room] created ${room.code}`);
  return room;
}

function closeRoom(reason) {
  if (!room) return;
  const closing = room;
  room = null;
  for (const m of closing.members.values()) {
    for (const s of m.sockets) {
      s.emit('room:closed', { reason });
      setTimeout(() => s.disconnect(true), 200);
    }
  }
  closing.destroy();
  console.log(`[room] closed ${closing.code}: ${reason}`);
}

function findRoom(code) {
  return room && room.code === String(code || '').trim().toUpperCase() ? room : null;
}

// Close a room nobody has been connected to for a while, so a new one can be created.
setInterval(() => {
  if (room && room.onlineCount === 0 && Date.now() - room.lastActivity > ROOM_IDLE_MINUTES * 60_000) {
    closeRoom('The room was empty for too long');
  }
}, 60_000).unref();

// ---------------------------------------------------------------- HTTP helpers
// Per-IP rate limit for room lookup / join / create (stops room-code guessing).
// Generous on purpose: in an office everyone often shares one public IP.
// Clip uploads (need a token) and clip downloads are not limited.
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const entry = hits.get(req.ip) || { count: 0, reset: now + 60_000 };
  if (now > entry.reset) {
    entry.count = 0;
    entry.reset = now + 60_000;
  }
  entry.count++;
  hits.set(req.ip, entry);
  if (entry.count > 300) return res.status(429).json({ error: 'Too many requests, please try again later' });
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of hits) if (now > e.reset) hits.delete(ip);
}, 60_000).unref();

// Idempotency: the client sends the same x-request-id when it retries,
// so a retried "join" or "create" returns the first answer instead of failing.
const replies = new Map();
function idempotent(req, res, next) {
  const reqId = req.get('x-request-id');
  if (!reqId) return next();
  const key = `${req.method}:${req.path}:${reqId}`;
  const cached = replies.get(key);
  if (cached) return res.status(cached.status).json(cached.body);
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) replies.set(key, { status: res.statusCode, body, expires: Date.now() + 5 * 60_000 });
    return json(body);
  };
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of replies) if (now > v.expires) replies.delete(k);
}, 60_000).unref();

const handle = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (err) {
    if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  }
};

// ---------------------------------------------------------------- REST API
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), roomActive: !!room }));

app.get('/api/status', (req, res) => res.json({ roomActive: !!room }));

app.post(
  '/api/rooms',
  rateLimit,
  express.json({ limit: '10kb' }),
  idempotent,
  handle((req, res) => {
    if (room) throw new GameError('A room is already running. Only one room can exist at a time', 409);
    const r = createRoom(req.body?.name);
    res.status(201).json({ code: r.code, playerId: r.host.id, token: r.host.token, name: r.host.name });
  })
);

app.get(
  '/api/rooms/:code',
  rateLimit,
  handle((req, res) => {
    const r = findRoom(req.params.code);
    if (!r) throw new GameError('Room not found. Check the code', 404);
    const players = [...r.members.values()].filter((m) => m.role !== 'host').length;
    res.json({ exists: true, players, maxPlayers: CONFIG.MAX_PLAYERS, full: players >= CONFIG.MAX_PLAYERS, phase: r.phase });
  })
);

app.post(
  '/api/rooms/:code/join',
  rateLimit,
  express.json({ limit: '10kb' }),
  idempotent,
  handle((req, res) => {
    const r = findRoom(req.params.code);
    if (!r) throw new GameError('Room not found. Check the code', 404);
    const m = r.addMember(req.body?.name, 'player');
    res.status(201).json({ code: r.code, playerId: m.id, token: m.token, name: m.name });
  })
);

app.post(
  '/api/rooms/:code/clips',
  express.raw({ type: 'audio/wav', limit: '4mb' }),
  handle((req, res) => {
    const r = findRoom(req.params.code);
    if (!r) throw new GameError('Room not found', 404);
    const m = r.authenticate(req.get('x-player-id'), req.get('x-token'));
    if (!m) throw new GameError('Invalid session', 401);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new GameError('No audio received');
    const out = r.submitClip(m, {
      roundId: req.get('x-round-id'),
      filter: req.get('x-filter'),
      phraseIndex: req.get('x-phrase-index'),
      buffer: req.body,
    });
    res.json(out);
  })
);

app.get('/api/clips/:clipId', (req, res) => {
  const buf = room && room.clips.get(req.params.clipId);
  if (!buf) return res.status(404).json({ error: 'Clip not found' });
  res.set('Cache-Control', 'private, max-age=3600').type('audio/wav').send(buf);
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API not found' }));

// ---------------------------------------------------------------- pages
app.use('/vendor/tone', express.static(TONE_DIR, { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('/room/:code', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'room.html')));
app.get('/host/:code', (req, res) => res.redirect(`/room/${encodeURIComponent(req.params.code)}`));

// ---------------------------------------------------------------- sockets
io.use((socket, next) => {
  const { code, playerId, token } = socket.handshake.auth || {};
  const r = findRoom(code);
  if (!r) return next(new Error('ROOM_NOT_FOUND'));
  const m = r.authenticate(playerId, token);
  if (!m) return next(new Error('INVALID_SESSION'));
  socket.data.memberId = m.id;
  next();
});

io.on('connection', (socket) => {
  const current = () => (room ? room.members.get(socket.data.memberId) : null);
  const me = current();
  if (!me) return socket.disconnect(true);
  room.memberConnected(me, socket);

  // Every action replies through an ack. A repeated reqId (client retry) gets the cached reply.
  const on = (event, fn) => {
    socket.on(event, (data, ack) => {
      if (typeof data === 'function') {
        ack = data;
        data = {};
      }
      data = data && typeof data === 'object' ? data : {};
      const reply = typeof ack === 'function' ? ack : () => {};
      const m = current();
      if (!m) return reply({ ok: false, error: 'You are no longer in the room' });
      const reqId = typeof data.reqId === 'string' ? data.reqId : null;
      if (reqId && m.reqCache.has(reqId)) return reply(m.reqCache.get(reqId));
      let result;
      try {
        result = fn(m, data) || { ok: true };
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        result = { ok: false, error: err instanceof GameError ? err.message : 'Something went wrong on the server' };
      }
      if (reqId) {
        m.reqCache.set(reqId, result);
        if (m.reqCache.size > 50) m.reqCache.delete(m.reqCache.keys().next().value);
      }
      reply(result);
    });
  };

  on('host:pick', (m) => room.pick(m));
  on('host:skip', (m) => room.staffSkip(m));
  on('host:end-voting', (m) => room.staffEndVoting(m));
  on('host:end-game', (m) => room.endGame(m));
  on('host:new-game', (m, d) => room.newGame(m, d.mode));
  on('host:kick', (m, d) => room.kick(m, d.playerId));
  on('host:set-role', (m, d) => room.setRole(m, d.playerId, d.role));
  on('host:settings', (m, d) => room.updateSettings(m, d));
  on('host:mode', (m, d) => room.setMode(m, d.mode));
  on('host:close-room', (m) => {
    room.requireHost(m);
    setTimeout(() => closeRoom('The host closed the room'), 50);
  });
  on('vote:cast', (m, d) => room.castVote(m, d));
  on('recorder:pass', (m, d) => room.recorderPass(m, d.roundId));
  on('recorder:shuffle', (m, d) => room.shufflePhrases(m, d.roundId));
  on('player:leave', (m) => room.leave(m));

  socket.on('disconnect', () => {
    const m = current();
    if (!m) return;
    room.memberDisconnected(m, socket);
  });
});

server.listen(PORT, () => {
  console.log(`Voice Guess Game running on http://localhost:${PORT}`);
  console.log(`[riddles] ${RIDDLES.length} riddle(s) ready${RIDDLES.length ? '' : ' (fill in the answers in server/riddles.js)'}`);
});

// Graceful stop for Docker
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    io.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
