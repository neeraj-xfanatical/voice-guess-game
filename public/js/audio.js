// Recording + voice filters (Tone.js) + WAV encoding.
// The filter runs in the browser, so the real voice never leaves the recorder's computer.
(function () {
  const OUTPUT_RATE = 24000;

  // Filters shown in the game. To turn one back on, add its id here AND in FILTERS in server/game.js.
  const ENABLED_FILTERS = ['chipmunk', 'radio', 'alien', 'ghost', 'none']; // 'none' = real voice

  // Every filter changes the pitch a bit so the voice is hard to recognise.
  const ALL_FILTERS = [
    {
      id: 'chipmunk', emoji: '🐿️', label: 'Chipmunk', desc: 'Squeaky cartoon voice',
      build: () => [new Tone.PitchShift({ pitch: 7, windowSize: 0.05 })],
    },
    {
      id: 'deep', emoji: '🎩', label: 'Deep', desc: 'Deep, heavy voice',
      build: () => [new Tone.PitchShift({ pitch: -6, windowSize: 0.08 })],
    },
    {
      id: 'monster', emoji: '👹', label: 'Monster', desc: 'Scary, heavy voice',
      build: () => [new Tone.PitchShift({ pitch: -9, windowSize: 0.08 }), new Tone.Distortion({ distortion: 0.35, wet: 0.6 })],
    },
    {
      id: 'robot', emoji: '🤖', label: 'Robot', desc: 'Machine-like voice',
      build: () => {
        // Ring modulation: multiply the voice with a 55 Hz sine wave
        const ring = new Tone.Gain(0);
        const osc = new Tone.Oscillator(55, 'sine').connect(ring.gain);
        osc.start(0);
        return [new Tone.PitchShift({ pitch: -3, windowSize: 0.05 }), ring, new Tone.Gain(1.6)];
      },
    },
    {
      id: 'alien', emoji: '👽', label: 'Alien', desc: 'Weird wobbly voice',
      build: () => [
        new Tone.PitchShift({ pitch: 4, windowSize: 0.04 }),
        new Tone.Vibrato({ frequency: 7, depth: 0.35 }),
        new Tone.Phaser({ frequency: 0.6, octaves: 3, baseFrequency: 600 }),
      ],
    },
    {
      id: 'radio', emoji: '📻', label: 'Radio', desc: 'Old walkie-talkie',
      build: () => [
        new Tone.PitchShift({ pitch: 3, windowSize: 0.05 }),
        new Tone.Filter({ type: 'bandpass', frequency: 1600, Q: 1.2 }),
        new Tone.Distortion({ distortion: 0.5, wet: 0.5 }),
        new Tone.Gain(2),
      ],
    },
    {
      id: 'cave', emoji: '🏛️', label: 'Cave', desc: 'Echo in a cave',
      tail: 2.5,
      build: async () => {
        const reverb = new Tone.Reverb({ decay: 3.5, wet: 0.45 });
        await reverb.ready;
        return [new Tone.PitchShift({ pitch: -4, windowSize: 0.08 }), new Tone.FeedbackDelay({ delayTime: 0.22, feedback: 0.35, wet: 0.3 }), reverb];
      },
    },
    {
      id: 'underwater', emoji: '🌊', label: 'Underwater', desc: 'Under the water',
      build: () => [
        new Tone.PitchShift({ pitch: -3, windowSize: 0.08 }),
        new Tone.Filter({ type: 'lowpass', frequency: 650, Q: 2 }),
        new Tone.Chorus({ frequency: 2, delayTime: 4, depth: 0.8, wet: 0.6 }).start(),
        new Tone.Vibrato({ frequency: 3, depth: 0.25 }),
        new Tone.Gain(1.8),
      ],
    },
    {
      id: 'none', emoji: '', label: 'No filter', desc: 'Your real voice',
      build: () => [new Tone.Gain(1)],
    },
    {
      id: 'ghost', emoji: '👻', label: 'Ghost', desc: 'Shaky ghostly voice',
      tail: 3,
      build: async () => {
        const reverb = new Tone.Reverb({ decay: 5, wet: 0.55 });
        await reverb.ready;
        return [
          new Tone.PitchShift({ pitch: 5, windowSize: 0.06 }),
          new Tone.Tremolo({ frequency: 7, depth: 0.7 }).start(),
          reverb,
        ];
      },
    },
  ];

  const FILTERS = ENABLED_FILTERS.map((id) => ALL_FILTERS.find((f) => f.id === id)); // shown in this order

  let decodeCtx = null;
  const getDecodeCtx = () => (decodeCtx ||= new AudioContext());

  async function getMic() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser does not support the mic. Use Chrome or Brave.');
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        throw new Error('Mic permission is blocked. Click the 🔒 icon in the address bar > Microphone > Allow, then reload the page.');
      if (err.name === 'NotFoundError') throw new Error('No mic found. Plug in a mic and try again.');
      if (err.name === 'NotReadableError') throw new Error('The mic is being used by another app. Close it and try again.');
      throw new Error('Could not start the mic: ' + err.message);
    }
  }

  async function testMic() {
    const stream = await getMic();
    stream.getTracks().forEach((t) => t.stop());
  }

  // Records up to maxSeconds. Returns { stop(), done: Promise<Blob> }
  async function startRecording(maxSeconds, onTick) {
    const stream = await getMic();
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    const startedAt = performance.now();
    let tick;
    let limit;

    const done = new Promise((resolve, reject) => {
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        clearInterval(tick);
        clearTimeout(limit);
        stream.getTracks().forEach((t) => t.stop()); // turn the mic light off
        resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
      };
      rec.onerror = (e) => {
        clearInterval(tick);
        clearTimeout(limit);
        stream.getTracks().forEach((t) => t.stop());
        reject(e.error || new Error('Recording failed'));
      };
    });

    rec.start(250);
    tick = setInterval(() => onTick && onTick((performance.now() - startedAt) / 1000), 100);
    limit = setTimeout(() => rec.state !== 'inactive' && rec.stop(), maxSeconds * 1000);
    return { stop: () => rec.state !== 'inactive' && rec.stop(), done };
  }

  async function decode(blob) {
    const buf = await blob.arrayBuffer();
    return await getDecodeCtx().decodeAudioData(buf);
  }

  // Renders the raw recording through the chosen filter (offline, faster than real time).
  async function applyFilter(raw, filterId, maxSeconds) {
    const filter = FILTERS.find((f) => f.id === filterId);
    if (!filter) throw new Error('Filter not found');
    if (typeof Tone === 'undefined') throw new Error('Audio library failed to load. Please reload the page.');
    const length = Math.min(raw.duration, maxSeconds);
    const total = length + (filter.tail || 0.4);

    const rendered = await Tone.Offline(async () => {
      const player = new Tone.Player(new Tone.ToneAudioBuffer(raw));
      const nodes = await filter.build();
      player.chain(...nodes);
      nodes[nodes.length - 1].toDestination();
      player.start(0, 0, length);
    }, total, 1, OUTPUT_RATE);

    const out = rendered.get ? rendered.get() : rendered;
    normalize(out);
    return out;
  }

  function normalize(buffer, target = 0.92) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak < 0.0001) return;
    const gain = Math.min(target / peak, 8);
    for (let i = 0; i < data.length; i++) data[i] *= gain;
  }

  // 16-bit mono PCM WAV. Plays in every browser and carries no metadata about who recorded it.
  function encodeWav(buffer) {
    const data = buffer.getChannelData(0);
    const rate = buffer.sampleRate;
    const out = new DataView(new ArrayBuffer(44 + data.length * 2));
    const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    out.setUint32(4, 36 + data.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true); // PCM
    out.setUint16(22, 1, true); // mono
    out.setUint32(24, rate, true);
    out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    str(36, 'data');
    out.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
  }

  window.VoiceFX = { FILTERS, testMic, startRecording, decode, applyFilter, encodeWav };
})();
