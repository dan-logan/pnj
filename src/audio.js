// Sound effects and haptics for the game UI. All sounds are synthesized with
// the Web Audio API (no asset files). Every entry point is a safe no-op when
// the environment has no AudioContext (tests) or the user has muted the game.

const STORAGE_KEY = 'pnj-muted';

let ctx = null;
let muted = false;
try {
  muted = localStorage.getItem(STORAGE_KEY) === '1';
} catch {
  // localStorage unavailable (private mode, tests) - default to sound on
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Persisting the preference is best-effort
  }
}

// Browsers only allow audio to start from a user gesture; call this from
// click handlers so the context is unlocked by the time sounds play.
export function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!ctx) ctx = new AC();
    if (ctx.state === 'suspended') ctx.resume();
  } catch {
    ctx = null;
  }
}

function tone({ freq, endFreq = null, start = 0, duration = 0.1, type = 'sine', volume = 0.12 }) {
  if (muted || !ctx) return;
  try {
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
    gain.gain.setValueAtTime(volume, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  } catch {
    // Never let audio failures break the game
  }
}

export function vibrate(pattern) {
  if (muted) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    // Vibration unsupported
  }
}

export const sfx = {
  // Your card lands a move
  cardPlay() {
    tone({ freq: 620, duration: 0.06, type: 'triangle' });
  },
  // An AI peg finishes its move (quieter, so 3 AI turns aren't noisy)
  peg() {
    tone({ freq: 440, duration: 0.05, type: 'triangle', volume: 0.05 });
  },
  // A peg gets bumped back to start
  bump() {
    tone({ freq: 320, endFreq: 110, duration: 0.28, type: 'sawtooth', volume: 0.16 });
    vibrate(80);
  },
  // A peg enters or advances in the home corridor
  home() {
    tone({ freq: 523, duration: 0.1 });
    tone({ freq: 784, start: 0.09, duration: 0.16 });
  },
  // Control returns to the human player
  yourTurn() {
    tone({ freq: 880, duration: 0.12, volume: 0.07 });
    vibrate(30);
  },
  win() {
    [523, 659, 784, 1047].forEach((freq, i) =>
      tone({ freq, start: i * 0.14, duration: 0.3, volume: 0.15 })
    );
    vibrate([100, 60, 100, 60, 300]);
  },
  lose() {
    tone({ freq: 392, duration: 0.22 });
    tone({ freq: 311, start: 0.18, duration: 0.35 });
    vibrate(150);
  }
};
