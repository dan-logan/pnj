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

// Each seat gets its own base pitch, so you can hear *who* is moving without
// looking up from your hand — the same way you'd know by the sound of someone's
// voice at the table. Yellow, Blue, Pink, Green: C5, G4, D#5, A4, spread wide
// enough apart to tell two of them apart back to back.
export const PLAYER_TONES = [523.25, 392.0, 622.25, 440.0];

function toneFor(player) {
  return PLAYER_TONES[player % PLAYER_TONES.length] ?? PLAYER_TONES[0];
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
  // One space of travel — the "click" of a peg being counted along the board.
  // `index` is the space number (0-based) and `total` the length of the move,
  // so the pitch creeps up as the count goes on and the final space lands on a
  // clear accent: you can hear a move finish without watching it.
  step(player, index = 0, total = 1) {
    const base = toneFor(player);
    const last = index >= total - 1;
    if (last) {
      tone({ freq: base * 1.5, duration: 0.09, type: 'triangle', volume: 0.1 });
      return;
    }
    // Capped so a 13-space King doesn't climb into a whistle.
    tone({
      freq: base * Math.pow(1.03, Math.min(index, 12)),
      duration: 0.035,
      type: 'square',
      volume: 0.05,
    });
  },
  // A peg leaves the start area for the track
  comeOut(player = 0) {
    const base = toneFor(player);
    tone({ freq: base * 0.75, duration: 0.07, type: 'triangle', volume: 0.11 });
    tone({ freq: base * 1.25, start: 0.06, duration: 0.12, type: 'triangle', volume: 0.13 });
    vibrate(25);
  },
  // You (or a seat you own) knocked someone back to start
  bumpDelivered() {
    tone({ freq: 320, endFreq: 110, duration: 0.28, type: 'sawtooth', volume: 0.16 });
    vibrate(80);
  },
  // One of your own pegs got knocked back — lower, longer and unmistakably
  // the bad one of the pair.
  bumpReceived() {
    tone({ freq: 260, endFreq: 70, duration: 0.42, type: 'sawtooth', volume: 0.18 });
    tone({ freq: 190, start: 0.1, endFreq: 60, duration: 0.35, type: 'square', volume: 0.1 });
    vibrate([120, 60, 90]);
  },
  // A partner bump in partner mode: it sends your teammate to their home
  // entrance, so it should sound like the good thing it is.
  friendlyBump(player = 0) {
    const base = toneFor(player);
    tone({ freq: base, duration: 0.08, type: 'triangle', volume: 0.12 });
    tone({ freq: base * 1.5, start: 0.07, duration: 0.14, type: 'triangle', volume: 0.13 });
    vibrate(40);
  },
  // A peg enters or advances in the home corridor
  home(player = 0) {
    const base = toneFor(player);
    tone({ freq: base, duration: 0.1 });
    tone({ freq: base * 1.5, start: 0.09, duration: 0.16 });
  },
  // A player's fifth and final peg lands: the whole seat is home. Bigger than
  // `home`, deliberately smaller than `win` — in partner mode it can happen
  // half a game before anyone actually wins.
  allHome(player = 0) {
    const base = toneFor(player);
    [1, 1.25, 1.5, 2].forEach((mult, i) =>
      tone({ freq: base * mult, start: i * 0.1, duration: 0.24, volume: 0.14 })
    );
    vibrate([60, 40, 60, 40, 120]);
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
