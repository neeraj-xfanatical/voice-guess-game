// End-to-end smoke test of the game flow (no browser, no mic).
// Run: npm test
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert/strict');
const { io } = require('socket.io-client');

const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(method, url, { json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (json) {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + url, { method, headers: h, body });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.arrayBuffer();
  return { status: res.status, data, type };
}

function wav(seconds, rate = 24000) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
}

function client(session) {
  const socket = io(BASE, { auth: session, transports: ['websocket'], reconnection: false });
  const c = { socket, state: null, events: [] };
  socket.on('room:state', (s) => (c.state = s));
  for (const ev of ['room:kicked', 'room:closed', 'room:left']) socket.on(ev, () => c.events.push(ev));
  c.send = (event, data = {}) => socket.timeout(3000).emitWithAck(event, data);
  c.ready = new Promise((res, rej) => {
    socket.once('room:state', () => res());
    socket.once('connect_error', rej);
  });
  return c;
}

async function waitFor(fn, label, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(20);
  }
  throw new Error('Timed out waiting for: ' + label);
}

let passed = 0;
const ok = (label) => {
  passed++;
  console.log('  ✓', label);
};

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DEFAULT_VOTE_SECONDS: '10',
      RECORDER_OFFLINE_SECONDS: '1',
      RECLAIM_AFTER_SECONDS: '1',
      RIDDLES_FILE: path.join(__dirname, 'riddles.fixture.js'),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((res) => server.stdout.on('data', (d) => d.toString().includes('running') && res()));
  const clients = [];

  try {
    // ---- REST
    let r = await http('GET', '/health');
    assert.equal(r.status, 200);
    ok('health check');

    r = await http('POST', '/api/rooms', { json: { name: 'Host' } });
    assert.equal(r.status, 201);
    const host = r.data;
    ok(`room created (${host.code})`);

    r = await http('POST', '/api/rooms', { json: { name: 'Host2' } });
    assert.equal(r.status, 409);
    ok('second room blocked (single room)');

    r = await http('GET', '/api/rooms/ZZZZZZ');
    assert.equal(r.status, 404);
    ok('wrong code -> 404');

    const join = (name, reqId) =>
      http('POST', `/api/rooms/${host.code.toLowerCase()}/join`, { json: { name }, headers: reqId ? { 'x-request-id': reqId } : {} });
    const A = (await join('Aman', 'req-a')).data;
    const again = await join('Aman', 'req-a');
    assert.equal(again.data.playerId, A.playerId);
    ok('join retry with same request id returns same player (idempotent)');
    assert.equal((await join('aman')).status, 409);
    ok('duplicate name blocked');
    const B = (await join('Bina')).data;
    const C = (await join('Chetan')).data;

    // ---- sockets
    const auth = (s) => ({ code: s.code, playerId: s.playerId, token: s.token });
    const [h, a, b, c] = [host, A, B, C].map((s) => client(auth(s)));
    clients.push(h, a, b, c);
    await Promise.all(clients.map((x) => x.ready));
    ok('all 4 sockets connected');

    const bad = client({ ...auth(A), token: 'nope' });
    await assert.rejects(bad.ready, /INVALID_SESSION/);
    bad.socket.close();
    ok('wrong token rejected');

    assert.equal((await h.send('host:set-role', { playerId: C.playerId, role: 'cohost' })).ok, true);
    await waitFor(() => c.state.me.role === 'cohost', 'cohost role');
    ok('host made Chetan co-host');

    let res = await a.send('host:pick', { reqId: 'x1' });
    assert.equal(res.ok, false);
    ok('player cannot use host controls');

    // ---- round 1
    res = await c.send('host:pick', { reqId: 'pick-1' });
    assert.equal(res.ok, true);
    await waitFor(() => [h, a, b, c].every((x) => x.state.phase === 'RECORDING'), 'recording phase');
    const dup = await c.send('host:pick', { reqId: 'pick-1' });
    assert.equal(dup.ok, true);
    ok('co-host picked; retried pick with same reqId is not run twice');

    const recorder = [a, b].find((x) => x.state.myTurn);
    const voter = recorder === a ? b : a;
    assert.ok(recorder, 'someone has myTurn');
    assert.equal([h, a, b, c].filter((x) => x.state.myTurn).length, 1);
    const firstOptions = recorder.state.myTurn.options;
    assert.equal(firstOptions.length, 3);
    assert.equal(new Set(firstOptions).size, 3);
    for (const x of [h, voter, c]) for (const p of firstOptions) assert.ok(!JSON.stringify(x.state).includes(p));
    ok('recorder gets 3 phrase options; nobody else sees them');

    const roundId = recorder.state.myTurn.roundId;
    assert.equal((await voter.send('recorder:shuffle', { roundId })).ok, false);
    assert.equal((await recorder.send('recorder:shuffle', { roundId })).ok, true);
    await waitFor(() => recorder.state.myTurn.options[0] !== firstOptions[0], 'shuffled options');
    const options = recorder.state.myTurn.options;
    assert.equal(options.length, 3);
    assert.ok(options.every((p) => !firstOptions.includes(p)));
    ok('shuffle gives 3 new phrases (only for the recorder)');

    const recSession = recorder === a ? A : B;
    const voterSession = recorder === a ? B : A;
    const upload = (s, buf, filter = 'radio', phraseIndex = '1') =>
      http('POST', `/api/rooms/${host.code}/clips`, {
        body: buf,
        headers: {
          'Content-Type': 'audio/wav',
          'x-player-id': s.playerId,
          'x-token': s.token,
          'x-round-id': roundId,
          'x-filter': filter,
          'x-phrase-index': phraseIndex,
        },
      });
    assert.equal((await upload(voterSession, wav(2))).status, 403);
    ok('non-recorder cannot upload');
    assert.equal((await upload(recSession, wav(30))).status, 400);
    ok('clip longer than 20s rejected');
    assert.equal((await upload(recSession, wav(2), 'banana')).status, 400);
    assert.equal((await upload(recSession, wav(2), 'robot')).status, 400);
    ok('unknown or turned-off filter rejected');
    assert.equal((await upload(recSession, wav(2), 'radio', '7')).status, 400);
    ok('invalid phrase choice rejected');
    r = await upload(recSession, wav(2));
    assert.equal(r.status, 200);
    r = await upload(recSession, wav(2));
    assert.equal(r.status, 200);
    assert.equal(r.data.duplicate, true);
    ok('recorder uploaded clip; retry upload is safe');

    await waitFor(() => voter.state.phase === 'VOTING' && voter.state.round.canVote, 'voting');
    assert.equal(h.state.round.canVote, false);
    assert.equal(c.state.round.canVote, false);
    assert.equal(recorder.state.round.canVote, false);
    assert.equal(recorder.state.round.amRecorder, true);
    assert.equal(voter.state.round.amRecorder, false);
    ok('only players vote (host, co-host and recorder cannot)');

    r = await http('GET', voter.state.round.clipUrl);
    assert.equal(r.status, 200);
    assert.ok(r.type.includes('audio/wav'));
    ok('clip downloadable');

    res = await voter.send('vote:cast', { roundId, targetId: voterSession.playerId });
    assert.equal(res.ok, false);
    ok('cannot vote for yourself');

    res = await voter.send('vote:cast', { roundId, targetId: recSession.playerId });
    assert.equal(res.ok, true);
    await waitFor(() => h.state.phase === 'REVEAL', 'reveal');
    ok('all voted -> auto reveal');
    assert.equal(h.state.round.result.recorderId, recSession.playerId);
    assert.equal(h.state.round.result.phrase, options[1]);
    ok('reveal shows the phrase the recorder chose');
    assert.equal(voter.state.me.score, 10);
    assert.equal(h.state.history.length, 1);
    assert.equal(voter.state.history, undefined);
    ok('scores correct (+10), history only sent to host/co-host');

    // ---- round 2: the other player must be picked (rotation), then pass
    await h.send('host:pick');
    await waitFor(() => voter.state.myTurn, 'rotation pick');
    ok('rotation: other player picked next');
    await voter.send('recorder:pass', { roundId: voter.state.myTurn.roundId });
    await waitFor(() => h.state.phase === 'LOBBY' && h.state.notice, 'pass');
    ok('recorder pass -> lobby with notice');

    // ---- not enough players after a kick
    await h.send('host:kick', { playerId: B.playerId });
    await waitFor(() => b.events.includes('room:kicked'), 'kicked event');
    ok('kick works');
    res = await h.send('host:pick');
    assert.equal(res.ok, false);
    ok('pick needs at least 2 online players');

    // ---- taking a seat back after losing the session
    const D = (await join('Dev')).data;
    let d = client(auth(D));
    clients.push(d);
    await d.ready;
    const amanScore = a.state.me.score;
    a.socket.close();
    await waitFor(() => h.state.members.some((m) => m.id === A.playerId && !m.online), 'Aman offline');
    assert.equal((await join('Aman')).status, 409);
    await sleep(1100);
    const A2 = (await join('Aman')).data;
    assert.equal(A2.playerId, A.playerId);
    assert.notEqual(A2.token, A.token);
    const stale = client(auth(A));
    await assert.rejects(stale.ready, /INVALID_SESSION/);
    stale.socket.close();
    let a2 = client(auth(A2));
    clients.push(a2);
    await a2.ready;
    assert.equal(a2.state.me.score, amanScore);
    ok('same name can take back an offline seat (score kept, old session stops working)');

    // ---- recorder goes offline -> round skipped
    await h.send('host:pick');
    await waitFor(() => a2.state.myTurn || d.state.myTurn, 'pick for offline test');
    const gone = a2.state.myTurn ? a2 : d;
    gone.socket.close();
    await waitFor(() => h.state.phase === 'LOBBY' && /offline/.test(h.state.notice?.text || ''), 'offline skip', 4000);
    ok('recorder offline -> round skipped after the grace time');
    if (gone === a2) {
      a2 = client(auth(A2));
      clients.push(a2);
      await a2.ready;
    } else {
      d = client(auth(D));
      clients.push(d);
      await d.ready;
    }

    // ---- end game during voting still keeps that round
    await h.send('host:pick');
    await waitFor(() => a2.state.myTurn || d.state.myTurn, 'pick for last round');
    const last = a2.state.myTurn ? a2 : d;
    const lastSession = last === a2 ? A2 : D;
    r = await http('POST', `/api/rooms/${host.code}/clips`, {
      body: wav(2),
      headers: {
        'Content-Type': 'audio/wav',
        'x-player-id': lastSession.playerId,
        'x-token': lastSession.token,
        'x-round-id': last.state.myTurn.roundId,
        'x-filter': 'ghost',
        'x-phrase-index': '0',
      },
    });
    assert.equal(r.status, 200);
    await waitFor(() => h.state.phase === 'VOTING', 'last voting');
    await h.send('host:end-game');
    await waitFor(() => a2.state.phase === 'ENDED', 'ended');
    ok('end game');
    assert.deepEqual(h.state.history.map((x) => x.number), [1, 2]);
    ok('round in voting is kept when the game ends; skipped rounds do not use up numbers');
    assert.equal(a2.state.replay.length, 2);
    assert.equal(a2.state.replay[0].phrase, options[1]);
    for (const x of a2.state.replay) assert.equal((await http('GET', x.clipUrl)).status, 200);
    ok('after the game every player can replay all clips');
    await h.send('host:close-room');
    await waitFor(() => a2.events.includes('room:closed'), 'closed');
    assert.equal((await http('GET', '/api/status')).data.roomActive, false);
    ok('close room -> new room can be created');

    // ---- Guess the Teammate
    const host2 = (await http('POST', '/api/rooms', { json: { name: 'Host' } })).data;
    const joinR = async (name) => (await http('POST', `/api/rooms/${host2.code}/join`, { json: { name } })).data;
    const [P, Q] = [await joinR('Priya'), await joinR('Quinn')];
    const [rh, rp, rq] = [host2, P, Q].map((s) => client(auth(s)));
    clients.push(rh, rp, rq);
    await Promise.all([rh, rp, rq].map((x) => x.ready));
    assert.equal(rh.state.mode, 'voice');
    assert.equal((await rp.send('host:mode', { mode: 'riddle' })).ok, false);
    assert.equal((await rh.send('host:mode', { mode: 'riddle' })).ok, true);
    await waitFor(() => rp.state.mode === 'riddle', 'riddle mode');
    assert.deepEqual(rp.state.riddles, { total: 3, asked: 0 });
    ok('host switches to Guess the Teammate');

    assert.equal((await rh.send('host:pick')).ok, true);
    await waitFor(() => rp.state.phase === 'VOTING' && rp.state.round.kind === 'riddle', 'riddle shown');
    let rr = rp.state.round;
    assert.equal(rr.riddle.title, 'The Secret Riddle One');
    assert.deepEqual(rr.choices, ['Kiran', 'Zoya']);
    assert.equal(rr.canAnswer, true);
    assert.equal(rh.state.round.canAnswer, false);
    assert.equal((await rh.send('host:mode', { mode: 'voice' })).ok, false);
    for (const x of [rh, rp, rq]) assert.ok(!JSON.stringify(x.state).includes('README.md'));
    ok('riddle shown with name choices; answer and photo are not sent before the reveal');

    assert.equal((await rp.send('vote:cast', { roundId: rr.id, choice: 'Nobody' })).ok, false);
    assert.equal((await rp.send('vote:cast', { roundId: rr.id, choice: 'Kiran' })).ok, true);
    assert.equal((await rp.send('vote:cast', { roundId: rr.id, choice: 'Zoya' })).ok, false);
    ok('invalid answer rejected; one answer per player');
    await sleep(50);
    assert.equal((await rq.send('vote:cast', { roundId: rr.id, choice: 'Zoya' })).ok, true);
    await waitFor(() => rh.state.phase === 'REVEAL' && rp.state.phase === 'REVEAL' && rq.state.phase === 'REVEAL', 'riddle reveal');
    const res1 = rh.state.round.result;
    assert.equal(res1.answer, 'Kiran');
    assert.equal(res1.photoUrl, '/photos/README.md');
    assert.equal(res1.fastest.name, 'Priya');
    assert.ok(rp.state.me.score >= 10 && rp.state.me.score <= 15, 'correct + speed bonus');
    assert.equal(rq.state.me.score, 0);
    ok(`all answered -> reveal with photo and fastest winner (Priya +${rp.state.me.score})`);

    // ---- team vote (no answer set): the most-voted name wins, a tie is shared
    await rh.send('host:pick');
    await waitFor(() => rq.state.phase === 'VOTING' && rq.state.round.riddleNumber === 2, 'team vote riddle');
    rr = rq.state.round;
    assert.equal(rr.teamVote, true);
    const before = [rp.state.me.score, rq.state.me.score];
    await rp.send('vote:cast', { roundId: rr.id, choice: 'Kiran' });
    await rq.send('vote:cast', { roundId: rr.id, choice: 'Zoya' });
    await waitFor(() => [rh, rp, rq].every((x) => x.state.phase === 'REVEAL'), 'team vote reveal');
    const tv = rh.state.round.result;
    assert.equal(tv.teamVote, true);
    assert.equal(tv.answer, 'Kiran & Zoya');
    assert.deepEqual(tv.tally, [{ name: 'Kiran', count: 1 }, { name: 'Zoya', count: 1 }]);
    assert.ok(rp.state.me.score > before[0] && rq.state.me.score > before[1]);
    ok('team vote: tally shown, tied names share the win and both voters score');

    await rh.send('host:pick');
    await waitFor(() => rq.state.phase === 'VOTING' && rq.state.round.riddleNumber === 3, 'riddle 3');
    rr = rq.state.round;
    assert.deepEqual(rr.choices, ['Coffee', 'Teamwork']);
    await rq.send('vote:cast', { roundId: rr.id, choice: 'Teamwork' });
    await rh.send('host:end-voting');
    await waitFor(() => rh.state.phase === 'REVEAL', 'riddle 2 reveal');
    assert.equal(rh.state.round.result.photoUrl, null);
    ok('own choices for a riddle; missing photo file -> no photo');
    assert.equal((await rh.send('host:pick')).ok, false);
    ok('no more riddles -> cannot start another');

    await rh.send('host:end-game');
    await waitFor(() => rp.state.phase === 'ENDED', 'riddle game ended');
    assert.deepEqual(rp.state.replay.map((x) => [x.kind, x.answer]), [['riddle', 'Kiran'], ['riddle', 'Kiran & Zoya'], ['riddle', 'Teamwork']]);
    assert.equal(rh.state.history.length, 3);
    ok('game over shows every riddle answer');
    await rh.send('host:mode', { mode: 'voice' }); // ignored: cannot switch on the Game over screen
    assert.equal((await rh.send('host:new-game', { mode: 'riddle' })).ok, true);
    await waitFor(() => rh.state.phase === 'LOBBY', 'new game');
    assert.equal(rh.state.mode, 'riddle');
    ok('New game can start straight into Guess the Teammate');
    assert.deepEqual(rh.state.riddles, { total: 3, asked: 0 });
    ok('new game resets the riddles');

    console.log(`\nAll ${passed} checks passed ✅`);
  } catch (err) {
    console.error('\n❌ FAILED:', err);
    process.exitCode = 1;
  } finally {
    clients.forEach((x) => x.socket.close());
    server.kill();
  }
})();
