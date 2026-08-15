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

// The bumped-peg fly-back, which is its own little animation: a peg knocked
// off the track arcs to wherever the bump sent it over `BUMP_FLY_STEPS` ticks.
// It is not tied to the speed setting — it is impact feedback, not travel you
// are meant to count, and it only runs at all when animations are on.
//
// A full second, and deliberately so. It used to take 560ms, which is long
// enough to notice that *something* flew but not to see what: the one question
// a player asks after a bump is "which peg was that, and where did it just
// go?", and answering it is the whole job of this animation. A peg that arcs
// slowly enough to follow with your eyes answers it; one that flicks does not.
//
// One card can displace more than one peg (a partner bump onto an entrance an
// opponent is sitting on sends the partner forward *and* the opponent home),
// and all of them fly from the same interval. They are staggered rather than
// simultaneous: a cascade is causal — this peg moved *because* that one did —
// and two pegs setting off together in different directions loses that, which
// is precisely the "which one was I supposed to be watching?" problem the
// Double Play! banner exists for. The stagger is deliberately shorter than a
// flight, so the chain overlaps and reads as one event rather than a queue.
export const BUMP_FLY_STEPS = 20;
export const BUMP_FLY_TICK_MS = 50;
export const BUMP_FLY_STAGGER = 8;

// One flight, in milliseconds — what a caller needs to know to hold the board
// until the pegs have stopped moving.
export const BUMP_FLY_MS = BUMP_FLY_STEPS * BUMP_FLY_TICK_MS;

// Tick offsets for `count` pegs flying off one move, and the tick at which the
// last of them lands (when the whole effect can be torn down). With one peg
// this is exactly the single-peg animation it replaced: starts at 0, ends at
// BUMP_FLY_STEPS.
//
// `leadCount` flights go *first and alone*: the following ones don't start
// until the lead has landed. That is the joker, whose own peg has to arrive on
// the target's space before the target can be knocked off it — the one
// displacement chain that is strictly sequential rather than a cascade you want
// to read as a single event. With `leadCount` 0 (every other move) this is
// byte-for-byte the staging it replaced.
export function stageBumpFlights(count, leadCount = 0) {
  const lead = Math.min(leadCount, count);
  const startTicks = [];
  for (let i = 0; i < count; i++) {
    startTicks.push(i < lead
      ? i * BUMP_FLY_STAGGER
      : (lead > 0 ? BUMP_FLY_STEPS : 0) + (i - lead) * BUMP_FLY_STAGGER);
  }
  return {
    startTicks,
    totalTicks: count > 0 ? Math.max(...startTicks) + BUMP_FLY_STEPS : 0,
  };
}

// The extra beat a *special* play earns before the next one starts.
//
// The moves with more than one moving part — a joker, any bump, a partner bump,
// a cascade — are the ones people lose the thread on, and the game used to roll
// straight from one into the opponent's thinking pause as if nothing had
// happened. Two seconds of nothing at all, after the pegs have stopped, is what
// turns "wait, what?" into "ah, right": long enough to look at the board and
// find the peg that moved, short enough not to feel like a hang.
//
// It is time *after* the effect finishes, not a slower effect — see
// `specialPlayHoldMs`, which is the whole thing a caller has to wait out.
export const SPECIAL_PAUSE_MS = 2000;

// The beat *between* the two halves of a split — the one card in the game that
// moves two different pegs off one play.
//
// A split used to run its halves back to back with nothing in between, and the
// eye read the result as one continuous motion by two pegs that had nothing to
// do with each other. Stopping between them is most of what makes a split
// legible: the first peg travels, stops, and is *seen* to have stopped, and
// only then does the second one set off.
//
// Never shorter than one space of travel, so the gap is always longer than the
// pauses inside each half's counting — a beat the same length as a step reads
// as one more step rather than as a break. Zero with animations off: there is
// no travel there to separate.
export function splitBeatMs(speed) {
  const { stepMs, settleMs } = settingsFor(speed);
  if (stepMs <= 0) return 0;
  return Math.max(settleMs, stepMs);
}

// The joker's moment. Its card is dealt face-up over the middle of the board
// and left there, throbbing, before it drops onto the pile and the peg sets off
// — the one card in the deck that rearranges the board without anything
// travelling, so the card itself has to do the announcing.
//
// JOKER_CARD_MS is the whole overlay animation (pop, throb, drop);
// JOKER_CARD_HOLD_MS is how much of that is the throb, and therefore when the
// peg starts to fly. The ratio between them is duplicated in the
// `pnj-card-joker` keyframes in index.css (the drop starts at 75%), which CSS
// can't read from here — change the two together.
export const JOKER_CARD_MS = 2400;
export const JOKER_CARD_HOLD_MS = Math.round(JOKER_CARD_MS * 0.75);

// How long the board must be held from the moment a move's effects *start*, so
// the next play doesn't begin on top of them: every flight this move will run
// (`totalTicks` is the staging above), and then the pause.
//
// Zero for an ordinary move, which is what keeps the game brisk between the
// special ones. Anything that happens before the effects start — a peg's travel,
// the joker's card throb — is the caller's own wait to add.
export function specialPlayHoldMs({ special = false, totalTicks = 0 } = {}) {
  if (!special) return 0;
  return totalTicks * BUMP_FLY_TICK_MS + SPECIAL_PAUSE_MS;
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
