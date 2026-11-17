let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx) {
      audioCtx = new Ctx();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function playTone(freqHz: number, durationMs: number, type: OscillatorType = 'sine', gainVal = 0.22) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freqHz, ctx.currentTime);

    gain.gain.setValueAtTime(gainVal, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
  } catch {
    // Ignorar si el navegador bloquea audio sin gesto previo
  }
}

export function feedbackFinishRecorded() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(45);
    } catch {
      // Ignorar en iOS / dispositivos sin motor háptico
    }
  }
  playTone(920, 65, 'triangle', 0.25);
}

export function feedbackUnassignedRecorded() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate([40, 30, 50]);
    } catch {}
  }
  playTone(680, 55, 'square', 0.2);
  setTimeout(() => playTone(1040, 65, 'square', 0.2), 65);
}

export function feedbackUndoOrVoid() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate(30);
    } catch {}
  }
  playTone(340, 90, 'sine', 0.22);
}

export function feedbackStartGun() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    try {
      navigator.vibrate([120, 50, 180]);
    } catch {}
  }
  playTone(520, 110, 'sawtooth', 0.3);
  setTimeout(() => playTone(1040, 260, 'sawtooth', 0.32), 120);
}
