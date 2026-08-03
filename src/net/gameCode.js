// Join-by-code generation. A game code is the short, typable secret a host
// reads out to a friend so they can claim the guest seat. It resolves to a game
// id and nothing else (see the security rules and §2.1 of the plan): the id
// alone grants no access, so a leaked code only lets someone race for the guest
// seat before your partner does — which the host can see and start over from.
//
// Everything here is pure so the alphabet and shape can be unit-tested without a
// backend. The randomness is injectable for the same reason.

// An unambiguous alphabet: no 0/O and no 1/I/L, so a code read aloud or off a
// screen can't be mistyped between look-alikes. 23 letters + 8 digits = 31.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

// A fresh code. `rand` returns a float in [0, 1) like Math.random; injecting it
// makes generation deterministic in tests and lets the caller supply a stronger
// source (crypto) in production.
export function generateCode(rand = defaultRand) {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return code;
}

// Prefer crypto for real codes so two hosts creating a game in the same
// millisecond don't collide as readily as Math.random can; fall back cleanly
// where crypto is unavailable (older engines, some test contexts).
function defaultRand() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] / 2 ** 32;
  }
  return Math.random();
}

// What a user types is forgiven: trimmed, upper-cased, and stripped of spaces
// and hyphens they might add for readability. It is NOT coerced into the
// alphabet — an out-of-alphabet character just fails the lookup, which is the
// honest outcome for a genuinely wrong code.
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input.toUpperCase().replace(/[\s-]+/g, '');
}

// True for a string that could be one of our codes. A cheap client-side guard
// before spending a Firestore read on the lookup.
export function isValidCodeShape(input) {
  const code = normalizeCode(input);
  return (
    code.length === CODE_LENGTH &&
    [...code].every((c) => CODE_ALPHABET.includes(c))
  );
}
