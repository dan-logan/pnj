import { describe, it, expect } from 'vitest';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  generateCode,
  normalizeCode,
  isValidCodeShape,
} from './gameCode.js';

describe('game code alphabet', () => {
  it('excludes the ambiguous characters 0/O and 1/I/L', () => {
    for (const c of ['0', 'O', '1', 'I', 'L']) {
      expect(CODE_ALPHABET.includes(c)).toBe(false);
    }
  });

  it('is all upper-case letters and digits', () => {
    expect(CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
  });
});

describe('generateCode', () => {
  it('produces a code of the right length from the alphabet', () => {
    const code = generateCode(() => 0.5);
    expect(code).toHaveLength(CODE_LENGTH);
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
  });

  it('is deterministic given the random source', () => {
    expect(generateCode(() => 0)).toBe(CODE_ALPHABET[0].repeat(CODE_LENGTH));
    // rand just below 1 lands on the last alphabet index.
    expect(generateCode(() => 0.999999)).toBe(CODE_ALPHABET[CODE_ALPHABET.length - 1].repeat(CODE_LENGTH));
  });

  it('walks the alphabet as the random source advances', () => {
    let i = 0;
    const seq = [0, 1, 2, 3, 4, 5].map((n) => n / CODE_ALPHABET.length);
    const code = generateCode(() => seq[i++]);
    expect(code).toBe(CODE_ALPHABET.slice(0, 6));
  });
});

describe('normalizeCode', () => {
  it('upper-cases and strips spaces and hyphens', () => {
    expect(normalizeCode(' ab2-3c4 ')).toBe('AB23C4');
  });

  it('is safe on non-strings', () => {
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode(undefined)).toBe('');
  });
});

describe('isValidCodeShape', () => {
  it('accepts a normalized 6-char code from the alphabet', () => {
    expect(isValidCodeShape('abc234')).toBe(true);
    expect(isValidCodeShape('ABC-234')).toBe(true);
  });

  it('rejects wrong length or out-of-alphabet characters', () => {
    expect(isValidCodeShape('ABC23')).toBe(false); // too short
    expect(isValidCodeShape('ABC2345')).toBe(false); // too long
    expect(isValidCodeShape('ABC20O')).toBe(false); // contains 0 and O
    expect(isValidCodeShape('')).toBe(false);
  });
});
