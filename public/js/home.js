(function () {
  const { Session, Results, api, toast } = window.VGG;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  if (params.get('code')) $('joinCode').value = params.get('code').toUpperCase();
  if (params.get('msg')) toast(params.get('msg'), 'error', 6000);
  if (Results.latest()) $('lastResults').classList.remove('hidden');

  const goToRoom = (code) => (location.href = `/room/${encodeURIComponent(code)}`);

  async function setBusy(btn, busy, text) {
    btn.disabled = busy;
    if (text) btn.textContent = text;
  }

  // Offer to rejoin a saved session if the room still exists
  async function checkResume() {
    const s = Session.get();
    if (!s || !s.code) return;
    try {
      await api(`/api/rooms/${encodeURIComponent(s.code)}`);
      $('resumeText').textContent = `Room ${s.code} · name: ${s.name}`;
      $('resume').classList.remove('hidden');
    } catch (err) {
      if (err.status === 404) Session.clear();
    }
  }

  async function checkRoomActive() {
    try {
      const { roomActive } = await api('/api/status');
      $('createBtn').disabled = roomActive;
      $('roomBusy').classList.toggle('hidden', !roomActive);
    } catch {}
  }

  $('resumeBtn').onclick = () => goToRoom(Session.get().code);
  $('forgetBtn').onclick = () => {
    Session.clear();
    $('resume').classList.add('hidden');
  };

  $('joinCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });

  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter || e.target.querySelector('button');
    const code = $('joinCode').value.trim().toUpperCase();
    const name = $('joinName').value.trim();
    if (code.length !== 6) return toast('Room code must be 6 characters', 'error');
    setBusy(btn, true, 'Joining...');
    try {
      // The server checks "room full" itself, so someone taking their seat back is not blocked here.
      const s = await api(`/api/rooms/${code}/join`, {
        method: 'POST',
        json: { name },
        onRetry: (n) => toast(`Connection is slow, retry ${n}...`),
      });
      Session.set({ code: s.code, playerId: s.playerId, token: s.token, name: s.name });
      goToRoom(s.code);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(btn, false, 'Join');
    }
  });

  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('createBtn');
    setBusy(btn, true, 'Creating...');
    try {
      const s = await api('/api/rooms', {
        method: 'POST',
        json: { name: $('hostName').value.trim() },
        onRetry: (n) => toast(`Connection is slow, retry ${n}...`),
      });
      Session.set({ code: s.code, playerId: s.playerId, token: s.token, name: s.name });
      goToRoom(s.code);
    } catch (err) {
      toast(err.message, 'error');
      setBusy(btn, false, 'Create room');
      checkRoomActive();
    }
  });

  checkResume();
  checkRoomActive();
  // Re-enable "Create room" when the running room closes, without a page refresh.
  setInterval(checkRoomActive, 10000);
})();
