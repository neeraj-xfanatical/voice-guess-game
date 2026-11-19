// Shared helpers: session storage, API calls with retry, toasts, results storage.
(function () {
  const SESSION_KEY = 'vgg_session';
  const RESULTS_KEY = 'vgg_results';

  const store = {
    get(key) {
      try {
        return JSON.parse(localStorage.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };

  const Session = {
    get: () => store.get(SESSION_KEY),
    set: (s) => store.set(SESSION_KEY, s),
    clear: () => store.remove(SESSION_KEY),
  };

  const uuid = () =>
    window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // fetch with timeout + retry (1s, 2s, 4s). Retries only network errors, 5xx and 429.
  // The same x-request-id is reused across retries so the server never does the work twice.
  async function api(path, { method = 'GET', json, body, headers = {}, retries = 3, timeout = 10000, onRetry } = {}) {
    const h = { ...headers };
    if (method !== 'GET') h['x-request-id'] = uuid();
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        onRetry && onRetry(attempt);
        await sleep(1000 * 2 ** (attempt - 1));
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const res = await fetch(path, { method, headers: h, body, signal: ctrl.signal });
        clearTimeout(timer);
        let data = null;
        try {
          data = await res.json();
        } catch {}
        if (res.ok) return data || {};
        const msg = (data && data.error) || `Error ${res.status}`;
        if (res.status >= 500 || res.status === 429) {
          lastError = new ApiError(msg, res.status);
          continue;
        }
        throw new ApiError(msg, res.status); // 4xx: retrying will not help
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof ApiError && err.status < 500 && err.status !== 429) throw err;
        lastError = err instanceof ApiError ? err : new ApiError('Unable to connect to the server', 0);
      }
    }
    throw lastError;
  }

  function toast(message, type = 'info', ms = 3500) {
    let box = document.getElementById('toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 300);
    }, ms);
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---- results kept in the host's browser, so they survive a server crash ----
  const Results = {
    all() {
      const data = store.get(RESULTS_KEY);
      return data && Array.isArray(data.games) ? data.games : [];
    },
    latest() {
      return this.all()[0] || null;
    },
    save(game) {
      const games = this.all().filter((g) => g.gameId !== game.gameId);
      games.unshift({ ...game, updatedAt: Date.now() });
      store.set(RESULTS_KEY, { games: games.slice(0, 5) });
    },
  };

  // ---- clip backup in IndexedDB (localStorage is far too small for audio) ----
  // Staff browsers copy every revealed clip here, so the clips can still be played
  // from the results page if the server restarts. Each clip is stored as { gameId, blob };
  // clips of other games are removed when a new game starts, everything when the room closes.
  const ClipStore = (() => {
    let dbPromise = null;
    const open = () =>
      (dbPromise ||= new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('IndexedDB not available'));
        const req = indexedDB.open('vgg_clips', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('clips');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('clips', mode);
        const req = fn(tx.objectStore('clips'));
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    };
    const inFlight = new Set();
    return {
      async getBlob(id) {
        const rec = await run('readonly', (s) => s.get(id)).catch(() => null);
        return (rec && rec.blob) || null;
      },
      clear: () => run('readwrite', (s) => s.clear()).catch(() => {}),
      // Deletes clips that belong to any other game.
      prune: (gameId) =>
        run('readwrite', (s) => {
          const req = s.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            if (!cur.value || cur.value.gameId !== gameId) cur.delete();
            cur.continue();
          };
          return req;
        }).catch(() => {}),
      async backup(id, url, gameId) {
        if (!id || !url || inFlight.has(id)) return;
        inFlight.add(id);
        try {
          if (await this.getBlob(id)) return;
          const res = await fetch(url);
          if (res.ok) {
            const blob = await res.blob();
            await run('readwrite', (s) => s.put({ gameId, blob }, id)).catch(() => {});
          }
        } catch {
        } finally {
          inFlight.delete(id);
        }
      },
    };
  })();

  // Gives every <audio data-clip-id> inside `container` a source:
  // the browser backup if there is one, otherwise the server URL.
  const blobUrls = new Map();
  async function attachClips(container) {
    for (const audio of container.querySelectorAll('audio[data-clip-id]')) {
      const id = audio.dataset.clipId;
      audio.onerror = () => {
        const note = document.createElement('p');
        note.className = 'muted small';
        note.textContent = 'Recording no longer available.';
        audio.replaceWith(note);
      };
      if (!blobUrls.has(id)) {
        const blob = await ClipStore.getBlob(id);
        if (blob) blobUrls.set(id, URL.createObjectURL(blob));
      }
      audio.src = blobUrls.get(id) || audio.dataset.clipUrl;
    }
  }

  function renderResults(game) {
    if (!game) return '<p class="muted">No results yet.</p>';
    const scores = [...(game.scores || [])].sort((a, b) => b.score - a.score);
    const board = scores.length
      ? `<ol class="leaderboard">${scores
          .map((s, i) => `<li><span class="rank">${i + 1}</span><span class="lb-name">${esc(s.name)}</span><span class="lb-score">${s.score}</span></li>`)
          .join('')}</ol>`
      : '<p class="muted">No players.</p>';
    const rounds = (game.history || [])
      .slice()
      .reverse()
      .map(
        (h) => `
      <details class="round-result">
        <summary><b>Round ${h.number}</b> · ${esc(h.recorderName)} <span class="muted">(${h.correctCount}/${h.voterCount} guessed right)</span></summary>
        <p class="muted">"${esc(h.phrase)}" · filter: ${esc(h.filter)}</p>
        ${h.clipId ? `<audio controls preload="none" data-clip-id="${esc(h.clipId)}" data-clip-url="${esc(h.clipUrl)}"></audio>` : ''}
        <ul class="vote-list">${
          h.votes.length
            ? h.votes.map((v) => `<li>${v.correct ? '<span class="mark ok">✓</span>' : '<span class="mark no">✗</span>'} ${esc(v.voterName)} → ${esc(v.targetName)}</li>`).join('')
            : '<li class="muted">Nobody voted</li>'
        }</ul>
      </details>`
      )
      .join('');
    return `
      <p class="muted small">Room ${esc(game.code)} · last update ${new Date(game.updatedAt || Date.now()).toLocaleString()}</p>
      <h4>Scoreboard</h4>${board}
      <h4>Rounds</h4>${rounds || '<p class="muted">No rounds finished yet.</p>'}`;
  }

  function downloadResultsCsv(game) {
    if (!game) return;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['SCOREBOARD', 'Rank,Name,Score'];
    [...(game.scores || [])]
      .sort((a, b) => b.score - a.score)
      .forEach((s, i) => lines.push([i + 1, q(s.name), s.score].join(',')));
    lines.push('', 'ROUNDS', 'Round,Recorder,Phrase,Filter,Voter,Guessed,Correct');
    for (const h of game.history || []) {
      if (!h.votes.length) lines.push([h.number, q(h.recorderName), q(h.phrase), h.filter, '', '', ''].join(','));
      for (const v of h.votes) {
        lines.push([h.number, q(h.recorderName), q(h.phrase), h.filter, q(v.voterName), q(v.targetName), v.correct ? 'YES' : 'NO'].join(','));
      }
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `voice-game-${game.code}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  window.VGG = { Session, Results, ClipStore, attachClips, api, ApiError, toast, esc, uuid, sleep, renderResults, downloadResultsCsv };
})();
