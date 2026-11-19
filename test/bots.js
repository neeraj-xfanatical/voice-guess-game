// Fake players for testing by yourself: they join a room and vote on their own.
//
//   npm run bots -- <ROOM_CODE> [how many, default 6] [server, default http://localhost:3000]
//
// Riddles: each bot votes after 1-10 seconds. Most bots lean towards the same name,
// so the team vote usually has a clear winner (sometimes a tie).
// Whose Voice?: bots cannot record, so a bot that is picked passes its turn; they vote at random.
// Press Ctrl+C to stop; the bots go offline (the host can kick them).
const { io } = require('socket.io-client');

const [code, countArg, baseArg] = process.argv.slice(2);
if (!code) {
  console.log('Usage: npm run bots -- <ROOM_CODE> [count] [server URL]');
  process.exit(1);
}
const COUNT = Math.min(20, Number(countArg) || 6);
const BASE = (baseArg || 'http://localhost:3000').replace(/\/$/, '');
const NAMES = ['Bot Asha', 'Bot Ravi', 'Bot Tara', 'Bot Kabir', 'Bot Nisha', 'Bot Arjun', 'Bot Diya', 'Bot Veer', 'Bot Isha', 'Bot Om'];
const rand = (n) => Math.floor(Math.random() * n);
const sockets = [];

async function startBot(i) {
  const name = (NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : '')).slice(0, 20);
  const res = await fetch(`${BASE}/api/rooms/${encodeURIComponent(code)}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const s = await res.json();
  if (!res.ok) throw new Error(`${name}: ${s.error}`);

  const socket = io(BASE, { auth: { code: s.code, playerId: s.playerId, token: s.token }, transports: ['websocket'] });
  sockets.push(socket);
  const acted = new Set(); // round ids this bot already voted / passed in
  const later = (roundId, fn) => {
    acted.add(roundId);
    setTimeout(fn, 1000 + rand(9000));
  };

  socket.on('room:state', (state) => {
    const r = state.round;
    if (state.myTurn && !acted.has(state.myTurn.roundId)) {
      later(state.myTurn.roundId, () => socket.emit('recorder:pass', { roundId: state.myTurn.roundId }, () => {}));
    }
    if (state.phase !== 'VOTING' || !r || acted.has(r.id)) return;
    if (r.kind === 'riddle' && r.canAnswer && !r.myAnswer) {
      // 70% pick the "favourite" name of this riddle, 30% pick any name.
      const favourite = r.choices[(r.riddleNumber * 7) % r.choices.length];
      const choice = Math.random() < 0.7 ? favourite : r.choices[rand(r.choices.length)];
      later(r.id, () => socket.emit('vote:cast', { roundId: r.id, choice }, (ack) => console.log(`${name} voted ${choice}${ack.ok ? '' : ` (${ack.error})`}`)));
    } else if (r.kind === 'voice' && r.canVote && !r.myVote) {
      const others = r.candidates.filter((c) => c.id !== state.me.id);
      if (others.length) {
        const target = others[rand(others.length)];
        later(r.id, () => socket.emit('vote:cast', { roundId: r.id, targetId: target.id }, () => {}));
      }
    }
  });
  socket.on('room:kicked', () => console.log(`${name} was kicked`));
  socket.on('room:closed', () => {
    console.log('Room closed, bye');
    process.exit(0);
  });
  console.log(`${name} joined`);
}

(async () => {
  for (let i = 0; i < COUNT; i++) {
    try {
      await startBot(i);
    } catch (err) {
      console.error(err.message);
    }
  }
  console.log(`\n${sockets.length} bot(s) in room ${code.toUpperCase()}. Press Ctrl+C to stop.`);
})();

process.on('SIGINT', () => {
  sockets.forEach((s) => s.close());
  process.exit(0);
});
