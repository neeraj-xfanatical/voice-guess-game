// Game logic for a single room. Everything lives in memory (no database).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const DEFAULT_PHRASES = require('./phrases');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

const CONFIG = {
  MAX_PLAYERS: num(process.env.MAX_PLAYERS, 25), // everyone except the host
  RECORD_PHASE_SECONDS: num(process.env.RECORD_PHASE_SECONDS, 90),
  MAX_CLIP_SECONDS: num(process.env.MAX_CLIP_SECONDS, 20),
  DEFAULT_VOTE_SECONDS: num(process.env.DEFAULT_VOTE_SECONDS, 30),
  DEFAULT_RIDDLE_SECONDS: num(process.env.DEFAULT_RIDDLE_SECONDS, 45),
  POINTS_CORRECT_GUESS: 10,
  POINTS_PER_FOOLED: 5,
  RIDDLE_SPEED_BONUS: 5, // a correct riddle answer gets up to this many extra points for being fast
  RECORDER_OFFLINE_SECONDS: num(process.env.RECORDER_OFFLINE_SECONDS, 20), // skip the round after this
  RECLAIM_AFTER_SECONDS: num(process.env.RECLAIM_AFTER_SECONDS, 15), // a seat can be taken back after this
};

const PHASE = {
  LOBBY: 'LOBBY',
  RECORDING: 'RECORDING',
  VOTING: 'VOTING',
  REVEAL: 'REVEAL',
  ENDED: 'ENDED',
};

// Must match ENABLED_FILTERS in public/js/audio.js
// (also built there, currently turned off: deep, monster, robot, cave, underwater)
const FILTERS = ['chipmunk', 'radio', 'alien', 'ghost', 'none']; // 'none' = real voice
const PHRASE_CHOICES = 3;
const MODES = ['voice', 'riddle'];

// ---------- "Guess the Teammate" riddles (server/riddles.js) ----------
const RIDDLES_FILE = process.env.RIDDLES_FILE ? path.resolve(process.env.RIDDLES_FILE) : path.join(__dirname, 'riddles.js');
const PHOTO_DIR = path.join(__dirname, '..', 'public', 'photos');
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function uniqueNames(list) {
  const seen = new Map();
  for (const raw of list) {
    const n = oneLine(raw);
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
}

// A riddle with an `answer` is a quiz. Without one it is a team vote: the most-voted name wins.
// Riddles with no text or nothing to choose from are skipped.
// Answers and photos never go to players before the reveal.
function loadRiddles() {
  const { TEAMMATES = [], RIDDLES = [] } = require(RIDDLES_FILE);
  const names = uniqueNames([...TEAMMATES, ...RIDDLES.filter((r) => !r.choices).map((r) => r.answer)]);
  return RIDDLES.map((r) => {
    const answer = oneLine(r.answer);
    const choices = r.choices ? uniqueNames([...r.choices, answer]) : names;
    return {
      title: oneLine(r.title),
      text: String(r.text || '').trim(),
      hard: !!r.hard,
      answer: answer ? choices.find((c) => c.toLowerCase() === answer.toLowerCase()) : null,
      choices,
      photo: r.photo ? path.basename(String(r.photo)) : '', // basename: no paths outside public/photos
    };
  }).filter((q) => q.text && q.choices.length >= 2);
}
const RIDDLES = loadRiddles();

const photoUrl = (file) => (file && fs.existsSync(path.join(PHOTO_DIR, file)) ? `/photos/${encodeURIComponent(file)}` : null);

class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const pickRandom = (arr) => arr[crypto.randomInt(arr.length)];

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return code;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 20) throw new GameError('Name must be 1 to 20 characters');
  return name;
}

// Reads duration from a PCM WAV buffer. Returns null if it is not a valid WAV.
function wavDurationSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let byteRate = null;
  let dataSize = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 20 <= buf.length) byteRate = buf.readUInt32LE(offset + 16);
    if (id === 'data') {
      dataSize = Math.min(size, buf.length - offset - 8);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || dataSize == null) return null;
  return dataSize / byteRate;
}

// What everyone sees about a finished round after the game ends.
function replayEntry(h) {
  const base = { kind: h.kind, number: h.number, correctCount: h.correctCount, voterCount: h.voterCount };
  if (h.kind === 'riddle') {
    return { ...base, title: h.title, answer: h.answer, photoUrl: h.photoUrl, fastestName: h.fastest ? h.fastest.name : null };
  }
  return { ...base, recorderName: h.recorderName, phrase: h.phrase, filter: h.filter, clipUrl: h.clipUrl };
}

class Room {
  constructor(hostName, hooks = {}) {
    this.code = makeCode();
    this.gameId = randomId(6);
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.members = new Map();
    this.phase = PHASE.LOBBY;
    this.round = null;
    this.history = [];
    this.settings = { mode: 'voice', voteSeconds: CONFIG.DEFAULT_VOTE_SECONDS, riddleSeconds: CONFIG.DEFAULT_RIDDLE_SECONDS, customPhrases: [] };
    this.pickedThisCycle = new Set();
    this.usedPhrases = new Set();
    this.usedRiddles = new Set(); // indexes into RIDDLES already asked this game
    this.clips = new Map();
    this.timer = null;
    this.notice = null;
    this.hooks = hooks; // { change(), removed(member, reason) }
    this.host = this.addMember(hostName, 'host');
  }

  // ---------- helpers ----------
  changed() {
    this.lastActivity = Date.now();
    this.hooks.change && this.hooks.change();
  }

  setNotice(text) {
    this.notice = text ? { text, at: Date.now() } : null;
  }

  setTimer(ms, fn) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isStaff(m) {
    return m && (m.role === 'host' || m.role === 'cohost');
  }

  requireStaff(m) {
    if (!this.isStaff(m)) throw new GameError('Only the host or a co-host can do this', 403);
  }

  requireHost(m) {
    if (!m || m.role !== 'host') throw new GameError('Only the host can do this', 403);
  }

  get onlineCount() {
    let n = 0;
    for (const m of this.members.values()) if (m.sockets.size) n++;
    return n;
  }

  // ---------- members ----------
  addMember(rawName, role = 'player') {
    const name = cleanName(rawName);
    const existing = [...this.members.values()].find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      // Someone lost their session (browser crash, new device): joining again with the same
      // name takes the seat back, with its score and role, once it has been offline a while.
      if (role !== 'host' && !existing.sockets.size) {
        if (Date.now() - existing.offlineSince >= CONFIG.RECLAIM_AFTER_SECONDS * 1000) {
          existing.token = randomId(24); // the old session stops working
          existing.reqCache.clear();
          this.changed();
          return existing;
        }
        throw new GameError(`This name belongs to someone who just went offline. If it is you, try again in ${CONFIG.RECLAIM_AFTER_SECONDS} seconds`, 409);
      }
      throw new GameError('This name is already taken, please choose another', 409);
    }
    const nonHost = [...this.members.values()].filter((m) => m.role !== 'host').length;
    if (role !== 'host' && nonHost >= CONFIG.MAX_PLAYERS) throw new GameError(`Room is full (max ${CONFIG.MAX_PLAYERS})`, 409);
    const member = {
      id: randomId(8),
      token: randomId(24),
      name,
      role,
      score: 0,
      joinedAt: Date.now(),
      offlineSince: Date.now(),
      sockets: new Set(),
      reqCache: new Map(),
    };
    this.members.set(member.id, member);
    if (role !== 'host') this.changed();
    return member;
  }

  memberConnected(m, socket) {
    m.sockets.add(socket);
    m.offlineSince = null;
    this.changed();
  }

  memberDisconnected(m, socket) {
    m.sockets.delete(socket);
    if (!m.sockets.size) {
      m.offlineSince = Date.now();
      const r = this.round;
      // A recorder who closed the tab or lost internet: skip the round if they are not back soon
      // (a page refresh comes back well within this time).
      if (r && this.phase === PHASE.RECORDING && r.recorderId === m.id) {
        const roundId = r.id;
        setTimeout(() => {
          const now = this.round;
          if (this.destroyed || this.phase !== PHASE.RECORDING || !now || now.id !== roundId) return;
          if (this.members.get(m.id)?.sockets.size) return;
          this.skipRound('The recorder went offline, round skipped');
        }, CONFIG.RECORDER_OFFLINE_SECONDS * 1000).unref();
      }
    }
    if (this.phase === PHASE.VOTING) this.checkAllVoted();
    this.changed();
  }

  authenticate(playerId, token) {
    const m = this.members.get(String(playerId || ''));
    if (!m || !safeEqual(m.token, token || '')) return null;
    return m;
  }

  removeMember(target, reason) {
    if (!target || !this.members.has(target.id)) return;
    this.members.delete(target.id);
    this.pickedThisCycle.delete(target.id);
    const r = this.round;
    if (r && this.phase === PHASE.RECORDING && r.recorderId === target.id) {
      this.skipRound('The recorder left the room, round skipped');
    } else if (r && this.phase === PHASE.VOTING) {
      r.voters.delete(target.id);
      r.votes.delete(target.id);
      this.checkAllVoted();
    }
    this.hooks.removed && this.hooks.removed(target, reason);
    this.changed();
  }

  kick(by, targetId) {
    this.requireStaff(by);
    const target = this.members.get(targetId);
    if (!target) throw new GameError('This player is not in the room', 404);
    if (target.role === 'host') throw new GameError('The host cannot be kicked');
    if (target.role === 'cohost' && by.role !== 'host') throw new GameError('Only the host can kick a co-host', 403);
    this.removeMember(target, 'kicked');
  }

  leave(member) {
    if (member.role === 'host') throw new GameError('The host cannot leave, use "Close room" instead');
    this.removeMember(member, 'left');
  }

  setRole(by, targetId, role) {
    this.requireHost(by);
    if (!['player', 'cohost'].includes(role)) throw new GameError('Invalid role');
    const target = this.members.get(targetId);
    if (!target) throw new GameError('This player is not in the room', 404);
    if (target.role === 'host') throw new GameError('The host role cannot be changed');
    if (target.role === role) return;
    target.role = role;
    const r = this.round;
    if (role === 'cohost') {
      this.pickedThisCycle.delete(target.id);
      if (r && this.phase === PHASE.RECORDING && r.recorderId === target.id) {
        this.skipRound('Round skipped');
      } else if (r && this.phase === PHASE.VOTING) {
        r.voters.delete(target.id);
        r.votes.delete(target.id);
        this.checkAllVoted();
      }
    }
    this.changed();
  }

  updateSettings(by, data = {}) {
    this.requireStaff(by);
    if (data.voteSeconds !== undefined) {
      const v = Math.round(Number(data.voteSeconds));
      if (!Number.isFinite(v) || v < 10 || v > 120) throw new GameError('Voting time must be between 10 and 120 seconds');
      this.settings.voteSeconds = v;
    }
    if (data.riddleSeconds !== undefined) {
      const v = Math.round(Number(data.riddleSeconds));
      if (!Number.isFinite(v) || v < 10 || v > 180) throw new GameError('Riddle time must be between 10 and 180 seconds');
      this.settings.riddleSeconds = v;
    }
    if (data.customPhrases !== undefined) {
      if (!Array.isArray(data.customPhrases)) throw new GameError('Invalid phrase list');
      this.settings.customPhrases = data.customPhrases
        .map((p) => String(p).replace(/\s+/g, ' ').trim())
        .filter((p) => p.length > 0 && p.length <= 150)
        .slice(0, 200);
    }
    this.changed();
  }

  setMode(by, mode) {
    this.requireStaff(by);
    if (!MODES.includes(mode)) throw new GameError('Invalid game mode');
    if (![PHASE.LOBBY, PHASE.REVEAL].includes(this.phase)) throw new GameError('Finish the current round before switching the game');
    if (this.settings.mode === mode) return;
    this.settings.mode = mode;
    this.changed();
  }

  // ---------- rounds ----------
  // Random phrases for the recorder to choose from. Skips phrases already said this game
  // and the ones currently on screen. One unused host phrase is always included if there is one.
  phraseOptions(exclude = []) {
    const skip = (p) => this.usedPhrases.has(p) || exclude.includes(p);
    const custom = this.settings.customPhrases.filter((p) => !skip(p));
    let pool = [...new Set([...DEFAULT_PHRASES, ...this.settings.customPhrases])].filter((p) => !skip(p));
    if (pool.length < PHRASE_CHOICES) {
      this.usedPhrases.clear(); // every phrase has been said, start over
      pool = [...new Set([...DEFAULT_PHRASES, ...this.settings.customPhrases])].filter((p) => !exclude.includes(p));
    }
    const out = custom.length ? [pickRandom(custom)] : [];
    const rest = pool.filter((p) => !out.includes(p));
    while (out.length < PHRASE_CHOICES && rest.length) out.push(rest.splice(crypto.randomInt(rest.length), 1)[0]);
    return out;
  }

  shufflePhrases(member, roundId) {
    const r = this.round;
    if (this.phase !== PHASE.RECORDING || !r || r.id !== roundId || r.recorderId !== member.id) {
      throw new GameError('It is not your turn right now', 409);
    }
    r.options = this.phraseOptions(r.options);
    this.changed();
  }

  pick(by) {
    this.requireStaff(by);
    if (![PHASE.LOBBY, PHASE.REVEAL].includes(this.phase)) throw new GameError('A round is already in progress');
    if (this.settings.mode === 'riddle') return this.startRiddle();
    const online = [...this.members.values()].filter((m) => m.role === 'player' && m.sockets.size > 0);
    if (online.length < 2) throw new GameError('At least 2 online players are needed');

    // Everyone gets a turn before anyone repeats.
    let pool = online.filter((m) => !this.pickedThisCycle.has(m.id));
    if (!pool.length) {
      this.pickedThisCycle.clear();
      pool = online;
    }
    const recorder = pickRandom(pool);
    this.pickedThisCycle.add(recorder.id);

    const deadline = Date.now() + CONFIG.RECORD_PHASE_SECONDS * 1000;
    this.round = {
      id: randomId(8),
      number: this.history.length + 1, // skipped rounds do not use up a number
      recorderId: recorder.id,
      options: this.phraseOptions(),
      phrase: null, // set when the recorder sends the clip
      filter: null,
      clipId: null,
      deadline,
      // Snapshot of who is in this round. Late joiners only watch.
      candidates: online.map((m) => ({ id: m.id, name: m.name })),
      voters: new Set(),
      votes: new Map(),
      result: null,
    };
    this.phase = PHASE.RECORDING;
    this.setNotice(null);
    this.setTimer(deadline - Date.now(), () => this.skipRound('Time is up, no clip was sent. Round skipped'));
    this.changed();
  }

  // Riddles are asked in the order of server/riddles.js. Every player answers once; correct answers
  // score POINTS_CORRECT_GUESS plus a speed bonus.
  startRiddle() {
    if (!RIDDLES.length) throw new GameError('No riddles are set up yet. Add riddles and names in server/riddles.js and restart the server');
    const index = RIDDLES.findIndex((_, i) => !this.usedRiddles.has(i));
    if (index < 0) throw new GameError('All riddles have been asked. Press End game to see the winner');
    const online = [...this.members.values()].filter((m) => m.role === 'player' && m.sockets.size > 0);
    if (online.length < 1) throw new GameError('At least 1 online player is needed');
    this.usedRiddles.add(index);
    const startedAt = Date.now();
    this.round = {
      kind: 'riddle',
      id: randomId(8),
      number: this.history.length + 1,
      riddleIndex: index,
      startedAt,
      deadline: startedAt + this.settings.riddleSeconds * 1000,
      voters: new Set(online.map((m) => m.id)), // players who join mid-riddle are added when they answer
      votes: new Map(), // playerId -> { choice, at }
      result: null,
    };
    this.phase = PHASE.VOTING;
    this.setNotice(null);
    this.setTimer(this.round.deadline - startedAt, () => this.reveal());
    this.changed();
  }

  answerRiddle(member, { roundId, choice }) {
    const r = this.round;
    if (this.phase !== PHASE.VOTING || !r || r.kind !== 'riddle' || r.id !== roundId) throw new GameError('Answering has closed', 409);
    if (member.role !== 'player') throw new GameError('Only players can answer', 403);
    if (r.votes.has(member.id)) throw new GameError('You have already answered this riddle', 409);
    const q = RIDDLES[r.riddleIndex];
    const pick = q.choices.find((c) => c === choice);
    if (!pick) throw new GameError('Invalid answer');
    r.voters.add(member.id);
    r.votes.set(member.id, { choice: pick, at: Date.now() });
    if (!this.checkAllVoted()) this.changed();
  }

  revealRiddle() {
    const r = this.round;
    const q = RIDDLES[r.riddleIndex];
    const total = Math.max(1, r.deadline - r.startedAt);

    // How many votes each name got, most first.
    const counts = new Map();
    for (const v of r.votes.values()) counts.set(v.choice, (counts.get(v.choice) || 0) + 1);
    const tally = [...counts]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // Quiz: the set answer. Team vote: the most-voted name(s); a tie shares the win.
    const teamVote = !q.answer;
    const top = tally.length ? tally[0].count : 0;
    const winners = teamVote ? tally.filter((t) => t.count === top).map((t) => t.name) : [q.answer];

    const votes = [...r.votes]
      .map(([voterId, v]) => {
        const correct = winners.includes(v.choice);
        const bonus = correct ? Math.round((CONFIG.RIDDLE_SPEED_BONUS * Math.max(0, r.deadline - v.at)) / total) : 0;
        return {
          voterId,
          voterName: this.members.get(voterId)?.name || '?',
          choice: v.choice,
          correct,
          points: correct ? CONFIG.POINTS_CORRECT_GUESS + bonus : 0,
          seconds: Math.round((v.at - r.startedAt) / 100) / 10,
        };
      })
      .sort((a, b) => a.seconds - b.seconds);
    for (const v of votes) {
      const m = this.members.get(v.voterId);
      if (m && v.points) m.score += v.points;
    }
    const fastest = votes.find((v) => v.correct);
    return {
      kind: 'riddle',
      roundId: r.id,
      number: r.number,
      riddleNumber: r.riddleIndex + 1,
      title: q.title,
      text: q.text,
      hard: q.hard,
      teamVote,
      answer: winners.length ? winners.join(' & ') : null, // null: team vote that nobody voted in
      photoUrl: photoUrl(q.photo),
      tally,
      votes,
      voterCount: r.voters.size,
      correctCount: votes.filter((v) => v.correct).length,
      fastest: fastest ? { id: fastest.voterId, name: fastest.voterName, seconds: fastest.seconds } : null,
      deltas: votes.filter((v) => v.points).map((v) => ({ id: v.voterId, name: v.voterName, points: v.points })),
      at: Date.now(),
    };
  }

  skipRound(message) {
    if (this.phase !== PHASE.RECORDING) return;
    this.clearTimer();
    this.round = null;
    this.phase = PHASE.LOBBY;
    this.setNotice(message);
    this.changed();
  }

  staffSkip(by) {
    this.requireStaff(by);
    if (this.phase !== PHASE.RECORDING) throw new GameError('No recording is in progress');
    this.skipRound('The host skipped the round');
  }

  recorderPass(member, roundId) {
    const r = this.round;
    if (this.phase !== PHASE.RECORDING || !r || r.id !== roundId || r.recorderId !== member.id) return; // idempotent
    this.skipRound('The recorder passed, round skipped');
  }

  submitClip(member, { roundId, filter, phraseIndex, buffer }) {
    const r = this.round;
    if (!r || r.id !== roundId) throw new GameError('This round has already ended', 409);
    if (r.recorderId !== member.id) throw new GameError('It is not your turn this round', 403);
    if (this.phase !== PHASE.RECORDING) {
      if (r.clipId) return { ok: true, duplicate: true }; // retry of an upload that already worked
      throw new GameError('You can no longer send a clip', 409);
    }
    if (!FILTERS.includes(filter)) throw new GameError('Invalid filter');
    const pi = Number(phraseIndex);
    if (!Number.isInteger(pi) || pi < 0 || pi >= r.options.length) throw new GameError('Invalid phrase, please choose one again');
    const seconds = wavDurationSeconds(buffer);
    if (seconds == null) throw new GameError('Invalid audio file');
    if (seconds < 0.3) throw new GameError('Recording is too short');
    if (seconds > CONFIG.MAX_CLIP_SECONDS + 4) throw new GameError(`Recording is longer than ${CONFIG.MAX_CLIP_SECONDS} seconds`);

    const clipId = randomId(16);
    this.clips.set(clipId, buffer);
    r.clipId = clipId;
    r.filter = filter;
    r.phrase = r.options[pi];
    this.usedPhrases.add(r.phrase);
    this.startVoting();
    return { ok: true };
  }

  startVoting() {
    const r = this.round;
    r.voters = new Set(r.candidates.map((c) => c.id).filter((id) => id !== r.recorderId && this.members.get(id)?.role === 'player'));
    r.votes = new Map();
    r.deadline = Date.now() + this.settings.voteSeconds * 1000;
    this.phase = PHASE.VOTING;
    this.setNotice(null);
    this.setTimer(r.deadline - Date.now(), () => this.reveal());
    this.changed();
  }

  castVote(member, data = {}) {
    if (this.round && this.round.kind === 'riddle') return this.answerRiddle(member, data);
    const { roundId, targetId } = data;
    const r = this.round;
    if (this.phase !== PHASE.VOTING || !r || r.id !== roundId) throw new GameError('Voting has closed', 409);
    if (!r.voters.has(member.id)) throw new GameError('You cannot vote in this round', 403);
    if (targetId === member.id) throw new GameError('You cannot vote for yourself');
    if (!r.candidates.some((c) => c.id === targetId)) throw new GameError('This player is not in this round');
    r.votes.set(member.id, targetId);
    if (!this.checkAllVoted()) this.changed();
  }

  // Reveals early when every online voter has voted. Returns true if revealed.
  checkAllVoted() {
    const r = this.round;
    if (this.phase !== PHASE.VOTING || !r) return false;
    const waiting = [...r.voters].filter((id) => !r.votes.has(id) && this.members.get(id)?.sockets.size > 0);
    if (r.voters.size > 0 && waiting.length === 0) {
      this.reveal();
      return true;
    }
    return false;
  }

  staffEndVoting(by) {
    this.requireStaff(by);
    if (this.phase !== PHASE.VOTING) throw new GameError('No voting is in progress');
    this.reveal();
  }

  reveal() {
    const r = this.round;
    if (this.phase !== PHASE.VOTING || !r) return;
    this.clearTimer();
    if (r.kind === 'riddle') {
      r.result = this.revealRiddle();
      this.history.push(r.result);
      this.phase = PHASE.REVEAL;
      this.changed();
      return;
    }
    const nameOf = (id) => r.candidates.find((c) => c.id === id)?.name || this.members.get(id)?.name || '?';
    const deltas = {};
    const add = (id, pts) => {
      deltas[id] = (deltas[id] || 0) + pts;
    };

    const votes = [...r.votes].map(([voterId, targetId]) => {
      const correct = targetId === r.recorderId;
      if (correct) add(voterId, CONFIG.POINTS_CORRECT_GUESS);
      else add(r.recorderId, CONFIG.POINTS_PER_FOOLED);
      return { voterId, voterName: nameOf(voterId), targetId, targetName: nameOf(targetId), correct };
    });
    for (const [id, pts] of Object.entries(deltas)) {
      const m = this.members.get(id);
      if (m) m.score += pts;
    }

    const result = {
      kind: 'voice',
      roundId: r.id,
      number: r.number,
      phrase: r.phrase,
      filter: r.filter,
      recorderId: r.recorderId,
      recorderName: nameOf(r.recorderId),
      clipId: r.clipId,
      clipUrl: `/api/clips/${r.clipId}`,
      votes,
      voterCount: r.voters.size,
      correctCount: votes.filter((v) => v.correct).length,
      deltas: Object.entries(deltas).map(([id, points]) => ({ id, name: nameOf(id), points })),
      at: Date.now(),
    };
    r.result = result;
    this.history.push(result);
    this.phase = PHASE.REVEAL;
    this.changed();
  }

  endGame(by) {
    this.requireStaff(by);
    if (this.phase === PHASE.ENDED) return;
    // Votes already cast still count, and the clip stays in the results and replay.
    if (this.phase === PHASE.VOTING) this.reveal();
    this.clearTimer();
    this.round = null;
    this.phase = PHASE.ENDED;
    this.setNotice(null);
    this.changed();
  }

  // `mode` (optional) picks which game the new game starts with.
  newGame(by, mode) {
    this.requireStaff(by);
    if (mode !== undefined && !MODES.includes(mode)) throw new GameError('Invalid game mode');
    if (mode) this.settings.mode = mode;
    this.clearTimer();
    for (const m of this.members.values()) m.score = 0;
    this.gameId = randomId(6);
    this.round = null;
    this.history = [];
    this.pickedThisCycle.clear();
    this.usedPhrases.clear();
    this.usedRiddles.clear();
    this.clips.clear();
    this.phase = PHASE.LOBBY;
    this.setNotice('New game started! All scores reset to 0');
    this.changed();
  }

  destroy() {
    this.destroyed = true;
    this.clearTimer();
    this.clips.clear();
    this.members.clear();
  }

  // ---------- state sent to each client ----------
  // Built per member so that secrets (who is recording, the phrase) only go to the right person.
  stateFor(me) {
    const staff = this.isStaff(me);
    const r = this.round;
    const roleOrder = { host: 0, cohost: 1, player: 2 };
    const members = [...this.members.values()]
      .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || a.joinedAt - b.joinedAt)
      .map((m) => ({ id: m.id, name: m.name, role: m.role, score: m.score, online: m.sockets.size > 0 }));

    let round = null;
    if (r && r.kind === 'riddle') {
      const q = RIDDLES[r.riddleIndex];
      round = {
        kind: 'riddle',
        id: r.id,
        number: r.number,
        deadline: r.deadline,
        riddleNumber: r.riddleIndex + 1,
        riddle: { title: q.title, text: q.text, hard: q.hard }, // no answer until the reveal
        teamVote: !q.answer,
        total: r.deadline - r.startedAt,
        choices: q.choices,
        voterCount: r.voters.size,
        votedCount: r.votes.size,
        canAnswer: this.phase === PHASE.VOTING && me.role === 'player',
        myAnswer: r.votes.get(me.id)?.choice || null,
      };
      if (this.phase === PHASE.REVEAL) round.result = r.result;
    } else if (r) {
      round = { kind: 'voice', id: r.id, number: r.number, deadline: r.deadline };
      if (this.phase === PHASE.VOTING || this.phase === PHASE.REVEAL) {
        round.candidates = r.candidates;
        round.clipUrl = r.clipId ? `/api/clips/${r.clipId}` : null;
        round.voterCount = r.voters.size;
        round.votedCount = r.votes.size;
        round.canVote = r.voters.has(me.id);
        round.myVote = r.votes.get(me.id) || null;
        round.amRecorder = r.recorderId === me.id; // only true in the recorder's own state
      }
      if (this.phase === PHASE.REVEAL) round.result = r.result;
    }

    return {
      code: this.code,
      gameId: this.gameId,
      serverNow: Date.now(),
      phase: this.phase,
      mode: this.settings.mode,
      riddles: { total: RIDDLES.length, asked: this.usedRiddles.size },
      notice: this.notice,
      limits: {
        maxPlayers: CONFIG.MAX_PLAYERS,
        maxClipSeconds: CONFIG.MAX_CLIP_SECONDS,
        recordPhaseSeconds: CONFIG.RECORD_PHASE_SECONDS,
        pointsCorrect: CONFIG.POINTS_CORRECT_GUESS,
        pointsFooled: CONFIG.POINTS_PER_FOOLED,
        riddleSpeedBonus: CONFIG.RIDDLE_SPEED_BONUS,
      },
      settings: staff ? this.settings : { voteSeconds: this.settings.voteSeconds, riddleSeconds: this.settings.riddleSeconds },
      me: { id: me.id, name: me.name, role: me.role, score: me.score },
      members,
      round,
      myTurn:
        this.phase === PHASE.RECORDING && r && r.recorderId === me.id
          ? { roundId: r.id, options: r.options, deadline: r.deadline }
          : null,
      history: staff ? this.history : undefined,
      // At the end everyone can replay every clip / see every riddle answer.
      replay: this.phase === PHASE.ENDED ? this.history.map(replayEntry) : undefined,
    };
  }
}

module.exports = { Room, GameError, CONFIG, PHASE, FILTERS, RIDDLES, wavDurationSeconds };
