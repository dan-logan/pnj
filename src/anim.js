// Animation pacing.
//
// The board used to have a single on/off animation toggle and one hard-coded
// 150ms-per-space step. That is faster than a person can follow a peg with
// their eyes, let alone count the spaces out loud the way you would at a real
// table, so the pace is now a setting with four values and `slow` is the
// default — the game should be followable before it is brisk.
//
// Kept out of the component (and out of the game engine) so the whole timing
// table is one thing a test can read, and so every timer in the UI derives
// from the same numbers instead of scattering magic milliseconds.

const STORAGE_KEY = 'pnj:animSpeed:v1';

export const DEFAULT_SPEED = 'slow';

// The cycle order of the header button: slowest → fastest → off → back round.
export const SPEED_ORDER = ['slow', 'normal', 'fast', 'off'];

// stepMs   — one space of peg travel (the "click" of counting it out)
// thinkMs  — how long an AI seat pauses before it plays, so you can see whose
//            turn it is before the board changes. At `slow` this is a full two
//            seconds: the "Blue is thinking…" banner and the seat's colour have
//            to be *read*, not glimpsed, and a player who has just looked up
//            from their hand needs the pause to find the board again before
//            anything on it moves. It reads as an opponent deliberating rather
//            than as lag precisely because it is that long.
// settleMs — the beat *after* a move lands, so three AI turns in a row read as
//            three separate events rather than one blur
export const SPEED_SETTINGS = {
  slow:   { stepMs: 320, thinkMs: 2000, settleMs: 450, label: 'Slow',   icon: '🐢' },
  normal: { stepMs: 150, thinkMs: 1200, settleMs: 200, label: 'Normal', icon: '▶️' },
  fast:   { stepMs: 70,  thinkMs: 400,  settleMs: 0,   label: 'Fast',   icon: '⏩' },
  // `off` still needs a thinking delay: with no animation at all, the only
  // thing separating one AI turn from the next is that pause.
  off:    { stepMs: 0,   thinkMs: 300, settleMs: 0,   label: 'Off',    icon: '⏸️' },
};

export function isSpeed(value) {
  return Object.prototype.hasOwnProperty.call(SPEED_SETTINGS, value);
}

export function settingsFor(speed) {
  return SPEED_SETTINGS[speed] ?? SPEED_SETTINGS[DEFAULT_SPEED];
}

export function stepMsFor(speed) {
  return settingsFor(speed).stepMs;
}

export function thinkMsFor(speed) {
  return settingsFor(speed).thinkMs;
}

export function settleMsFor(speed) {
  return settingsFor(speed).settleMs;
}

// Animations are "on" for every speed except `off` — the rest of the component
// still asks that one yes/no question in a dozen places (replay, bump fly-back,
// the remote text summary), and this keeps it a derivation rather than a second
// piece of state that can disagree with the speed.
export function animationsOn(speed) {
  return speed !== 'off';
}

export function nextSpeed(speed) {
  const i = SPEED_ORDER.indexOf(speed);
  return SPEED_ORDER[(i + 1) % SPEED_ORDER.length];
}

// Storage is injectable (the stats.js / persistence.js pattern) so tests never
// touch a real localStorage and a browser without one simply gets the default.
function defaultStorage() {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSpeed(storage = defaultStorage()) {
  if (!storage) return DEFAULT_SPEED;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return isSpeed(raw) ? raw : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

export function saveSpeed(speed, storage = defaultStorage()) {
  if (!storage || !isSpeed(speed)) return;
  try {
    storage.setItem(STORAGE_KEY, speed);
  } catch {
    // Persisting the preference is best-effort
  }
}
