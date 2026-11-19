(function () {
  const { Session, Results, ClipStore, attachClips, api, toast, esc, uuid, sleep, renderResults, downloadResultsCsv } = window.VGG;
  const { FILTERS } = window.VoiceFX;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------ session
  const urlCode = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase();
  const session = Session.get();
  if (!session || session.code !== urlCode) {
    location.replace(`/?code=${encodeURIComponent(urlCode)}`);
    return;
  }

  let state = null;
  let clockOffset = 0; // server time - local time
  let leaving = false; // true when leaving on purpose (no refresh warning)
  let stageKey = '';
  let settingsLoaded = false;
  let resultsSig = '';
  let prunedFor = null;

  // Recorder-side state (lives only in this browser)
  const rec = {
    roundId: null,
    status: 'idle', // idle | recording | processing | ready | sending | sent
    filter: FILTERS[0].id,
    phraseIndex: 0,
    optionsSig: '',
    raw: null,
    wav: null,
    previewUrl: null,
    handle: null,
    renderToken: 0,
  };

  // Voice test (practice only, never uploaded). Disabled while a round is running.
  const test = {
    status: 'idle', // idle | recording | processing | ready
    filter: FILTERS[0].id,
    raw: null,
    previewUrl: null,
    handle: null,
    token: 0,
  };
  let testEnabled = null;
  const testAllowed = () => state && !['RECORDING', 'VOTING'].includes(state.phase);

  const filterLabel = (id) => (FILTERS.find((f) => f.id === id) || {}).label || id;

  const filterButtons = (active, action) =>
    FILTERS.map(
      (f) => `<button class="filter-btn ${f.id === active ? 'active' : ''}" data-action="${action}" data-filter="${f.id}">
        <span class="fl">${f.label}</span><span class="fd">${f.desc}</span></button>`
    ).join('');

  const now = () => Date.now() + clockOffset;
  const isStaff = () => state && (state.me.role === 'host' || state.me.role === 'cohost');
  const fmtTime = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // ------------------------------------------------------------ socket
  const socket = io({
    auth: { code: session.code, playerId: session.playerId, token: session.token },
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  function setConn(kind, text) {
    $('connDot').className = `dot ${kind}`;
    $('connText').textContent = text;
  }

  socket.on('connect', () => setConn('on', 'Connected'));
  socket.on('disconnect', (reason) => {
    if (!leaving) setConn('wait', 'Reconnecting...');
    if (reason === 'io server disconnect' && !leaving) setTimeout(() => socket.connect(), 1000);
  });
  socket.io.on('reconnect_attempt', (n) => setConn('wait', `Reconnecting... (${n})`));
  socket.on('connect_error', (err) => {
    if (err.message === 'ROOM_NOT_FOUND' || err.message === 'INVALID_SESSION') {
      socket.disconnect();
      endSession(
        'Room no longer exists',
        err.message === 'ROOM_NOT_FOUND'
          ? 'This room has been closed or the server restarted.'
          : 'Your session is no longer valid. Please join again.'
      );
    } else {
      setConn('off', 'Cannot reach the server, retrying...');
    }
  });

  socket.on('room:state', (s) => {
    clockOffset = s.serverNow - Date.now();
    state = s;
    render();
  });
  socket.on('room:kicked', () => endSession('You were removed from the room', 'The host or a co-host kicked you.'));
  socket.on('room:left', () => {
    leaving = true;
    Session.clear();
    location.href = '/';
  });
  socket.on('room:closed', ({ reason } = {}) => {
    ClipStore.clear(); // the session is over, recordings go away
    endSession('Room closed', reason || 'The host closed the room.');
  });

  // Emit with ack + retry (1s, 2s, 4s). The same reqId is reused so the server never runs it twice.
  class UserError extends Error {}
  async function send(event, data = {}) {
    const payload = { ...data, reqId: uuid() };
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const res = await socket.timeout(5000).emitWithAck(event, payload);
        if (!res || !res.ok) throw new UserError((res && res.error) || 'Something went wrong');
        return res;
      } catch (err) {
        if (err instanceof UserError) {
          toast(err.message, 'error');
          throw err;
        }
        if (attempt === 3) {
          toast('Could not reach the server. Check your internet and try again.', 'error');
          throw err;
        }
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  function endSession(title, text) {
    leaving = true;
    Session.clear();
    // Turn the mic off if anything was still recording.
    if (rec.handle) rec.handle.stop();
    stopTest();
    const hasResults = !!Results.latest();
    showOverlay(title, text, [
      { label: 'Home', onClick: () => (location.href = '/') },
      ...(hasResults ? [{ label: 'Results', secondary: true, onClick: () => (location.href = '/results') }] : []),
    ]);
  }

  function showOverlay(title, text, buttons) {
    $('overlayTitle').textContent = title;
    $('overlayText').textContent = text;
    const box = $('overlayButtons');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.secondary) el.className = 'secondary';
      el.onclick = b.onClick;
      box.appendChild(el);
    }
    $('overlay').classList.remove('hidden');
  }

  // ------------------------------------------------------------ refresh warning
  window.addEventListener('beforeunload', (e) => {
    if (leaving) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ------------------------------------------------------------ render
  function render() {
    renderTopbar();
    renderNotice();
    renderMembers();
    renderControls();
    renderSettings();
    saveAndRenderResults();
    renderStage();
    renderTestPanel();
  }

  function renderTopbar() {
    $('roomCode').textContent = state.code;
    const role = state.me.role;
    $('meInfo').innerHTML =
      `<b>${esc(state.me.name)}</b> <span class="role-badge ${role}">${role === 'cohost' ? 'co-host' : role}</span>` +
      (role === 'player' ? ` <span class="muted small">· ${state.me.score} pts</span>` : '');
    $('leaveBtn').textContent = role === 'host' ? 'Close room' : 'Leave';
    $('leaveBtn').classList.toggle('danger', role === 'host');
    $('layout').classList.toggle('staff', isStaff());
  }

  function renderNotice() {
    const n = state.notice;
    const show = n && now() - n.at < 15000;
    $('notice').classList.toggle('hidden', !show);
    if (show) $('notice').textContent = n.text;
  }

  function renderMembers() {
    const players = state.members.filter((m) => m.role === 'player');
    $('membersTitle').textContent = `Players (${players.length}/${state.limits.maxPlayers})`;
    const amHost = state.me.role === 'host';
    $('members').innerHTML = state.members
      .map((m) => {
        const actions = [];
        if (amHost && m.role === 'player') actions.push(`<button class="secondary" data-action="role" data-id="${m.id}" data-role="cohost" title="Make co-host">Co-host</button>`);
        if (amHost && m.role === 'cohost') actions.push(`<button class="secondary" data-action="role" data-id="${m.id}" data-role="player" title="Make player again">Player</button>`);
        const canKick = isStaff() && m.role !== 'host' && m.id !== state.me.id && (m.role === 'player' || amHost);
        if (canKick) actions.push(`<button class="danger" data-action="kick" data-id="${m.id}" data-name="${esc(m.name)}" title="Kick">Kick</button>`);
        return `<li class="${m.id === state.me.id ? 'me' : ''}">
          <span class="dot ${m.online ? 'on' : 'off'}"></span>
          <span class="m-name">${esc(m.name)}</span>
          ${m.role !== 'player' ? `<span class="role-badge ${m.role}">${m.role === 'cohost' ? 'co-host' : 'host'}</span>` : `<span class="m-score">${m.score}</span>`}
          ${actions.length ? `<span class="m-actions">${actions.join('')}</span>` : ''}
        </li>`;
      })
      .join('');
  }

  function renderControls() {
    const panel = $('controlsPanel');
    panel.classList.toggle('hidden', !isStaff());
    if (!isStaff()) return;
    const p = state.phase;
    const b = [];
    if (p === 'LOBBY' || p === 'REVEAL') b.push(`<button class="big" data-action="pick">${p === 'REVEAL' ? 'Next round' : 'Pick random player'}</button>`);
    if (p === 'RECORDING') b.push(`<button class="secondary" data-action="skip">Skip round</button>`);
    if (p === 'VOTING') b.push(`<button class="secondary" data-action="end-voting">End voting now</button>`);
    if (p !== 'ENDED') b.push(`<button class="secondary" data-action="end-game">End game</button>`);
    if (p === 'ENDED') b.push(`<button class="good" data-action="new-game">New game</button>`);
    const online = state.members.filter((m) => m.role === 'player' && m.online).length;
    b.push(`<p class="muted small" style="margin:.2rem 0 0">${online} players online</p>`);
    $('controls').innerHTML = b.join('');
  }

  function renderSettings() {
    $('settingsPanel').classList.toggle('hidden', !isStaff());
    if (!isStaff() || settingsLoaded) return;
    $('voteSeconds').value = state.settings.voteSeconds;
    $('customPhrases').value = (state.settings.customPhrases || []).join('\n');
    settingsLoaded = true;
  }

  // Staff keep a copy of all results in localStorage (survives refresh and server crash).
  function saveAndRenderResults() {
    $('resultsPanel').classList.toggle('hidden', !isStaff());
    if (!isStaff() || !state.history) return;
    const scores = state.members.filter((m) => m.role === 'player').map((m) => ({ name: m.name, score: m.score }));
    const sig = JSON.stringify([state.gameId, state.history.length, scores]);
    if (sig === resultsSig) return;
    resultsSig = sig;
    const game = { gameId: state.gameId, code: state.code, scores, history: state.history };
    // Never overwrite saved rounds with an emptier list (e.g. server restarted).
    const saved = Results.all().find((g) => g.gameId === state.gameId);
    if (!saved || saved.history.length <= state.history.length) Results.save(game);
    $('results').innerHTML = renderResults(Results.all().find((g) => g.gameId === state.gameId) || game);
    attachClips($('results'));
    // Keep a copy of every clip in this browser, in case the server restarts.
    // A new game (new gameId) removes the copies of the previous one.
    if (prunedFor !== state.gameId) {
      prunedFor = state.gameId;
      ClipStore.prune(state.gameId);
    }
    for (const h of state.history) ClipStore.backup(h.clipId, h.clipUrl, state.gameId);
  }

  // ------------------------------------------------------------ stage
  function renderStage() {
    const r = state.round;
    const key = [state.phase, r && r.id, state.myTurn ? 'turn' : '', r && r.amRecorder ? 'mine' : '', r && r.canVote ? 'vote' : '', state.me.role].join('|');
    if (key !== stageKey) {
      stageKey = key;
      $('stage').innerHTML = buildStage();
      if (state.myTurn) renderRecPanel();
    }
    updateStage();
  }

  function buildStage() {
    const s = state;
    const r = s.round;
    switch (s.phase) {
      case 'LOBBY':
        return `<div class="stage-center">
          <h2 class="phase-title">Lobby</h2>
          <p class="muted">${isStaff() ? 'When everyone is here, press <b>Pick random player</b>.' : 'Waiting for the host to start the round...'}</p>
          ${s.me.role === 'player' ? '<p class="muted small">Try the Voice test below. It also gives mic permission now, so you do not waste time when your turn comes.</p>' : ''}
          <p class="muted small">Correct guess: +${s.limits.pointsCorrect} · Recorder gets per wrong guess: +${s.limits.pointsFooled}</p>
        </div>`;

      case 'RECORDING':
        if (s.myTurn) {
          return `<div class="banner mute">Everyone, mute yourself on Meet</div>
            <div class="row" style="justify-content:space-between">
              <h2 style="margin:0">It's your turn <span class="muted small">(keep it secret)</span></h2>
              <span class="timer" data-deadline="${s.myTurn.deadline}"></span>
            </div>
            <p class="muted" style="margin:0">Mute yourself on Meet first. Choose a phrase, pick a filter, record and listen, then send. Say only the phrase, and don't tell anyone!</p>
            <div class="row" style="justify-content:space-between;align-items:flex-end">
              <h4 style="margin-bottom:0">1. Choose your phrase</h4>
              <button class="secondary small" data-action="shuffle">Shuffle</button>
            </div>
            <div class="phrase-options" id="phraseOptions"></div>
            <h4>2. Pick a filter</h4>
            <div class="filters" id="filterGrid">${filterButtons(rec.filter, 'filter')}</div>
            <h4>3. Record (max ${s.limits.maxClipSeconds} seconds)</h4>
            <div class="rec-panel" id="recPanel"></div>
            <div style="text-align:right"><button class="secondary small" data-action="pass">Pass, skip my turn</button></div>`;
        }
        return `<div class="banner mute">Everyone, mute yourself on Meet</div>
          <div class="stage-center">
            <h2 class="phase-title">Someone is secretly recording...</h2>
            <p class="muted">Round ${r.number} · Waiting for the clip</p>
            <div class="timer" data-deadline="${r.deadline}"></div>
          </div>`;

      case 'VOTING': {
        let body;
        if (r.canVote) {
          body = `<p style="margin:0"><b>Whose voice is this?</b> <span class="muted small">You can change your vote until time runs out.</span></p>
            <div class="vote-grid">${r.candidates
              .filter((c) => c.id !== s.me.id)
              .map((c) => `<button class="vote-btn" data-action="vote" data-id="${c.id}">${esc(c.name)}</button>`)
              .join('')}</div>`;
        } else if (r.amRecorder) {
          body = `<div class="stage-center"><p>This is <b>your</b> clip. Keep a straight face and see who figures it out.</p></div>`;
        } else if (isStaff()) {
          body = `<p class="muted">You are the ${s.me.role === 'host' ? 'host' : 'co-host'}, so you do not vote. Wait for everyone to vote.</p>`;
        } else {
          body = `<p class="muted">You joined in the middle of this round. Just listen this round and play from the next one.</p>`;
        }
        return `<div class="banner unmute">The clip is here. You can unmute on Meet now</div>
          <div class="row" style="justify-content:space-between">
            <h2 style="margin:0">Round ${r.number}: Who is it?</h2>
            <span class="timer" data-deadline="${r.deadline}"></span>
          </div>
          <audio controls preload="auto" src="${esc(r.clipUrl)}"></audio>
          <p class="muted" id="voteProgress"></p>
          ${body}`;
      }

      case 'REVEAL': {
        const res = r.result;
        const myDelta = res.deltas.find((d) => d.id === s.me.id);
        return `<div class="stage-center" style="padding-bottom:1rem">
            <p class="muted">Round ${res.number}: the voice was...</p>
            <div class="reveal-name">${esc(res.recorderName)}</div>
            <p>"${esc(res.phrase)}" <span class="muted">· filter: ${esc(filterLabel(res.filter))}</span></p>
            <p><b>${res.correctCount}/${res.voterCount}</b> guessed right</p>
            ${myDelta ? `<p class="points-pop">+${myDelta.points} points for you</p>` : ''}
          </div>
          <audio controls preload="auto" src="${esc(r.clipUrl)}"></audio>
          <h4>Who voted for whom</h4>
          <ul class="vote-list">${
            res.votes.length
              ? res.votes.map((v) => `<li>${v.correct ? '<span class="mark ok">✓</span>' : '<span class="mark no">✗</span>'} ${esc(v.voterName)} → ${esc(v.targetName)}</li>`).join('')
              : '<li class="muted">Nobody voted</li>'
          }</ul>
          <p class="muted small">${isStaff() ? 'Press <b>Next round</b> to continue.' : 'The host will start the next round...'}</p>`;
      }

      case 'ENDED': {
        const players = s.members.filter((m) => m.role === 'player').sort((a, b) => b.score - a.score);
        return `<div class="stage-center">
          <h2 class="phase-title">Game over!</h2>
          ${players[0] ? `<p>Winner: <b>${esc(players[0].name)}</b> (${players[0].score} pts)</p>` : ''}
        </div>
        <ol class="leaderboard">${players
          .map((p, i) => `<li><span class="rank">${i + 1}</span><span class="lb-name">${esc(p.name)}</span><span class="lb-score">${p.score}</span></li>`)
          .join('')}</ol>
        ${
          s.replay && s.replay.length
            ? `<h4>Listen again</h4>
          <div class="replay-list">${s.replay
            .map(
              (h) => `<div class="round-result">
              <p style="margin:.2rem 0"><b>Round ${h.number}</b> · ${esc(h.recorderName)} <span class="muted">(${h.correctCount}/${h.voterCount} guessed right)</span></p>
              <p class="muted small" style="margin:.2rem 0 .5rem">"${esc(h.phrase)}" · filter: ${esc(filterLabel(h.filter))}</p>
              <audio controls preload="none" src="${esc(h.clipUrl)}"></audio>
            </div>`
            )
            .join('')}</div>`
            : ''
        }`;
      }
    }
    return '';
  }

  // Parts that change without rebuilding the stage
  function updateStage() {
    const r = state.round;
    if (state.phase === 'VOTING' && r) {
      const vp = $('voteProgress');
      if (vp) vp.textContent = `${r.votedCount}/${r.voterCount} have voted`;
      document.querySelectorAll('.vote-btn').forEach((b) => b.classList.toggle('selected', b.dataset.id === r.myVote));
    }
    if (state.myTurn) {
      if (rec.roundId !== state.myTurn.roundId) resetRecorder(state.myTurn.roundId);
      renderPhraseOptions();
    } else if (rec.status === 'recording' && rec.handle) {
      rec.handle.stop(); // round ended while recording
    }
  }

  // ------------------------------------------------------------ recorder flow
  function resetRecorder(roundId) {
    if (rec.handle) rec.handle.stop();
    if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
    Object.assign(rec, { roundId, status: 'idle', phraseIndex: 0, optionsSig: '', raw: null, wav: null, previewUrl: null, handle: null, renderToken: rec.renderToken + 1 });
    renderRecPanel();
  }

  // The phrase can be changed (or shuffled) before recording, or after recording
  // (that throws the recording away). It is locked while recording or sending.
  const phraseLocked = () => !['idle', 'ready'].includes(rec.status);

  function discardRecording() {
    if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
    Object.assign(rec, { status: 'idle', raw: null, wav: null, previewUrl: null, renderToken: rec.renderToken + 1 });
    renderRecPanel();
  }

  function renderPhraseOptions() {
    const box = $('phraseOptions');
    if (!box || !state.myTurn) return;
    const options = state.myTurn.options || [];
    const sig = options.join('\n');
    if (sig !== rec.optionsSig) {
      if (rec.optionsSig) rec.phraseIndex = 0; // new options after a shuffle
      rec.optionsSig = sig;
    }
    const locked = phraseLocked();
    const key = [sig, rec.phraseIndex, locked].join('|');
    if (box.dataset.key === key) return;
    box.dataset.key = key;
    box.innerHTML = options
      .map(
        (p, i) => `<button class="phrase-btn ${i === rec.phraseIndex ? 'active' : ''}" data-action="phrase" data-index="${i}" ${locked ? 'disabled' : ''}>
          ${esc(p)}</button>`
      )
      .join('');
    const shuffle = document.querySelector('[data-action="shuffle"]');
    if (shuffle) shuffle.disabled = locked;
  }

  function renderRecPanel() {
    const box = $('recPanel');
    if (!box) return;
    const max = state.limits.maxClipSeconds;
    switch (rec.status) {
      case 'idle':
        box.innerHTML = `<button class="rec-btn" data-action="record" title="Record"><span class="rec-dot"></span></button><p class="muted">Press and start speaking</p>`;
        break;
      case 'recording':
        box.innerHTML = `<button class="rec-btn recording" data-action="stop" title="Stop"><span class="rec-square"></span></button>
          <div class="progress"><div id="recBar"></div></div>
          <p><b id="recTime">0.0</b> / ${max}s · press stop when you are done</p>`;
        break;
      case 'processing':
        box.innerHTML = `<div class="spinner"></div><p class="muted">Applying filter...</p>`;
        break;
      case 'ready':
        box.innerHTML = `<p>Listen to how it sounds. You can also try other filters.</p>
          <audio controls src="${rec.previewUrl}"></audio>
          <div class="row">
            <button class="secondary" data-action="rerecord">Record again</button>
            <button class="good big" data-action="send-clip">Send clip</button>
          </div>`;
        break;
      case 'sending':
        box.innerHTML = `<div class="spinner"></div><p class="muted">Sending clip...</p>`;
        break;
      case 'sent':
        box.innerHTML = `<p>Clip sent. Voting is about to start.</p>`;
        break;
    }
    renderPhraseOptions();
  }

  async function startRecording() {
    if (!state.myTurn) return;
    const max = state.limits.maxClipSeconds;
    const roundId = rec.roundId;
    try {
      rec.status = 'recording';
      renderRecPanel();
      const handle = await VoiceFX.startRecording(max, (sec) => {
        const t = $('recTime');
        const bar = $('recBar');
        if (t) t.textContent = Math.min(sec, max).toFixed(1);
        if (bar) bar.style.width = `${Math.min(100, (sec / max) * 100)}%`;
      });
      // The round may have ended while the browser was asking for mic permission.
      if (rec.roundId !== roundId || !state.myTurn) return handle.stop();
      rec.handle = handle;
      const blob = await handle.done;
      rec.handle = null;
      if (rec.roundId !== roundId || !state.myTurn) return;
      rec.status = 'processing';
      renderRecPanel();
      rec.raw = await VoiceFX.decode(blob);
      if (rec.raw.duration < 0.3) throw new Error('Recording is too short, try again');
      await processFilter();
    } catch (err) {
      if (rec.roundId !== roundId) return;
      rec.handle = null;
      rec.raw = null;
      rec.status = 'idle';
      renderRecPanel();
      toast(err.message || 'Recording failed', 'error', 7000);
    }
  }

  async function processFilter() {
    if (!rec.raw) return;
    const token = ++rec.renderToken;
    rec.status = 'processing';
    renderRecPanel();
    try {
      const out = await VoiceFX.applyFilter(rec.raw, rec.filter, state.limits.maxClipSeconds);
      if (token !== rec.renderToken) return; // a newer filter was chosen meanwhile
      if (rec.previewUrl) URL.revokeObjectURL(rec.previewUrl);
      rec.wav = VoiceFX.encodeWav(out);
      rec.previewUrl = URL.createObjectURL(rec.wav);
      rec.status = 'ready';
    } catch (err) {
      if (token !== rec.renderToken) return;
      console.error(err);
      toast('Problem applying filter: ' + err.message, 'error');
      rec.status = 'idle';
      rec.raw = null;
    }
    renderRecPanel();
  }

  async function sendClip() {
    if (!rec.wav || !state.myTurn) return;
    rec.status = 'sending';
    renderRecPanel();
    try {
      await api(`/api/rooms/${encodeURIComponent(session.code)}/clips`, {
        method: 'POST',
        body: rec.wav,
        headers: {
          'Content-Type': 'audio/wav',
          'x-player-id': session.playerId,
          'x-token': session.token,
          'x-round-id': rec.roundId,
          'x-filter': rec.filter,
          'x-phrase-index': String(rec.phraseIndex),
        },
        timeout: 20000,
        onRetry: (n) => toast(`Upload is slow, retry ${n}...`),
      });
      rec.status = 'sent';
    } catch (err) {
      toast(err.message, 'error', 6000);
      rec.status = 'ready';
    }
    renderRecPanel();
  }

  // ------------------------------------------------------------ voice test (local only)
  function renderTestPanel() {
    $('testPanel').classList.remove('hidden');
    const allowed = testAllowed();
    if (allowed === testEnabled) return;
    testEnabled = allowed;
    $('testBody').classList.toggle('hidden', !allowed);
    $('testNote').textContent = allowed
      ? 'Pick a filter, say anything and listen. Only you hear it, nothing is sent.'
      : 'Voice test is not available while a round is in progress.';
    if (allowed) {
      $('testFilters').innerHTML = filterButtons(test.filter, 'test-filter');
      renderTestRec();
    } else {
      stopTest();
    }
  }

  function clearTestPreview() {
    const audio = document.querySelector('#testRec audio');
    if (audio) audio.pause();
    if (test.previewUrl) URL.revokeObjectURL(test.previewUrl);
    test.previewUrl = null;
  }

  function stopTest() {
    test.token++; // cancels any recording/processing still in flight
    if (test.handle) test.handle.stop();
    clearTestPreview();
    Object.assign(test, { status: 'idle', raw: null, handle: null });
    renderTestRec();
  }

  function renderTestRec() {
    const box = $('testRec');
    const max = state ? state.limits.maxClipSeconds : 20;
    switch (test.status) {
      case 'idle':
        box.innerHTML = `<button class="rec-btn" data-action="test-record" title="Record"><span class="rec-dot"></span></button><p class="muted">Press and say anything</p>`;
        break;
      case 'recording':
        box.innerHTML = `<button class="rec-btn recording" data-action="test-stop" title="Stop"><span class="rec-square"></span></button>
          <div class="progress"><div id="testBar"></div></div>
          <p><b id="testTime">0.0</b> / ${max}s · press stop when you are done</p>`;
        break;
      case 'processing':
        box.innerHTML = `<div class="spinner"></div><p class="muted">Applying filter...</p>`;
        break;
      case 'ready':
        box.innerHTML = `<p>Listen. Pick another filter to hear the same recording with it.</p>
          <audio controls autoplay src="${test.previewUrl}"></audio>
          <button class="secondary" data-action="test-record">Record again</button>`;
        break;
    }
  }

  async function startTest() {
    if (!testAllowed()) return;
    const max = state.limits.maxClipSeconds;
    const my = ++test.token;
    clearTestPreview();
    test.raw = null;
    test.status = 'recording';
    renderTestRec();
    try {
      const handle = await VoiceFX.startRecording(max, (sec) => {
        const t = $('testTime');
        const bar = $('testBar');
        if (t) t.textContent = Math.min(sec, max).toFixed(1);
        if (bar) bar.style.width = `${Math.min(100, (sec / max) * 100)}%`;
      });
      if (my !== test.token) return handle.stop(); // a round started while waiting for the mic
      test.handle = handle;
      const blob = await handle.done;
      test.handle = null;
      if (my !== test.token) return;
      test.status = 'processing';
      renderTestRec();
      const raw = await VoiceFX.decode(blob);
      if (my !== test.token) return;
      if (raw.duration < 0.3) throw new Error('Recording is too short, try again');
      test.raw = raw;
      await processTest();
    } catch (err) {
      if (my !== test.token) return;
      Object.assign(test, { status: 'idle', raw: null, handle: null });
      renderTestRec();
      toast(err.message || 'Recording failed', 'error', 7000);
    }
  }

  async function processTest() {
    if (!test.raw) return;
    const my = ++test.token;
    test.status = 'processing';
    renderTestRec();
    try {
      const out = await VoiceFX.applyFilter(test.raw, test.filter, state.limits.maxClipSeconds);
      if (my !== test.token) return;
      clearTestPreview();
      test.previewUrl = URL.createObjectURL(VoiceFX.encodeWav(out));
      test.status = 'ready';
    } catch (err) {
      if (my !== test.token) return;
      toast('Problem applying filter: ' + err.message, 'error');
      test.status = 'idle';
      test.raw = null;
    }
    renderTestRec();
  }

  // ------------------------------------------------------------ actions (event delegation)
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const a = el.dataset.action;
    const r = state && state.round;
    const withBusy = async (fn) => {
      el.disabled = true;
      try {
        await fn();
      } catch {
      } finally {
        el.disabled = false;
      }
    };

    switch (a) {
      case 'pick': return withBusy(() => send('host:pick'));
      case 'skip': return confirm('Skip this round?') && withBusy(() => send('host:skip'));
      case 'end-voting': return withBusy(() => send('host:end-voting'));
      case 'end-game': return confirm('End the game and show the final scoreboard?') && withBusy(() => send('host:end-game'));
      case 'new-game':
        if (!confirm('Start a new game? All scores reset to 0 and the recordings are deleted (old scores stay saved in your browser).')) return;
        return withBusy(() => send('host:new-game'));
      case 'kick': return confirm(`Remove ${el.dataset.name} from the room?`) && withBusy(() => send('host:kick', { playerId: el.dataset.id }));
      case 'role': return withBusy(() => send('host:set-role', { playerId: el.dataset.id, role: el.dataset.role }));

      case 'test-filter': {
        test.filter = el.dataset.filter;
        document.querySelectorAll('#testFilters .filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === test.filter));
        if (test.raw && test.status !== 'recording') processTest();
        return;
      }
      case 'test-record': return startTest();
      case 'test-stop': return test.handle && test.handle.stop();

      case 'vote': {
        if (!r) return;
        const prev = r.myVote;
        r.myVote = el.dataset.id;
        updateStage();
        try {
          await send('vote:cast', { roundId: r.id, targetId: el.dataset.id });
        } catch {
          r.myVote = prev;
          updateStage();
        }
        return;
      }

      case 'filter': {
        if (['recording', 'sending', 'sent'].includes(rec.status)) return;
        rec.filter = el.dataset.filter;
        document.querySelectorAll('#filterGrid .filter-btn').forEach((b) => b.classList.toggle('active', b.dataset.filter === rec.filter));
        if (rec.raw) processFilter();
        return;
      }
      case 'record': return startRecording();
      case 'stop': return rec.handle && rec.handle.stop();
      case 'rerecord':
        rec.raw = null;
        rec.wav = null;
        rec.renderToken++;
        return startRecording();
      case 'send-clip': return sendClip();
      case 'phrase': {
        if (phraseLocked()) return;
        const i = Number(el.dataset.index);
        if (i === rec.phraseIndex) return;
        rec.phraseIndex = i;
        if (rec.status === 'ready') {
          discardRecording();
          toast('Phrase changed. Please record again.');
        } else {
          renderPhraseOptions();
        }
        return;
      }
      case 'shuffle':
        if (!state.myTurn || phraseLocked()) return;
        if (rec.status === 'ready' && !confirm('Shuffle the phrases? Your recording will be discarded.')) return;
        if (rec.status === 'ready') discardRecording();
        return withBusy(() => send('recorder:shuffle', { roundId: state.myTurn.roundId }));
      case 'pass':
        if (!state.myTurn || !confirm('Are you sure? This round will be skipped.')) return;
        return withBusy(() => send('recorder:pass', { roundId: state.myTurn.roundId }));
    }
  });

  $('roomCode').onclick = async () => {
    try {
      await navigator.clipboard.writeText(state ? state.code : session.code);
      toast('Room code copied', 'success');
    } catch {}
  };

  $('leaveBtn').onclick = async () => {
    if (!state) return;
    if (state.me.role === 'host') {
      if (!confirm('Close the room? Everyone will be removed and the recordings are deleted. (Scores stay saved in your browser)')) return;
      try {
        await send('host:close-room');
      } catch {}
      return;
    }
    if (!confirm('Leave the room? Your score will be lost.')) return;
    try {
      leaving = true;
      await send('player:leave');
    } catch {
      leaving = false;
      return;
    }
    Session.clear();
    location.href = '/';
  };

  $('saveSettings').onclick = async () => {
    const voteSeconds = Number($('voteSeconds').value);
    const lines = $('customPhrases').value.split('\n').map((s) => s.trim()).filter(Boolean);
    const customPhrases = lines.filter((s) => s.length <= 150);
    try {
      await send('host:settings', { voteSeconds, customPhrases });
      toast('Settings saved', 'success');
      if (customPhrases.length < lines.length) {
        toast(`${lines.length - customPhrases.length} phrase(s) longer than 150 characters were skipped`, 'error', 6000);
      }
    } catch {}
  };

  $('downloadCsv').onclick = () => {
    const game = state && Results.all().find((g) => g.gameId === state.gameId);
    downloadResultsCsv(game || Results.latest());
  };

  // ------------------------------------------------------------ timers
  setInterval(() => {
    document.querySelectorAll('[data-deadline]').forEach((el) => {
      const left = Number(el.dataset.deadline) - now();
      el.textContent = fmtTime(left);
      el.classList.toggle('low', left < 10000);
    });
    if (state) renderNotice();
  }, 250);
})();
