import { describe, it, expect } from 'vitest';
import {
  announcementsFor, isSpecialPlay, ANNOUNCEMENTS, TAUNT_TEXT, ANNOUNCE_MS, TAUNT_MS,
  THANKS_TEXT, WELCOME_TEXT, GLOAT_TEXT, REPLY_MS,
} from './announce.js';

const kinds = (result) => result.map(a => a.kind);

// Shapes matching what findBumps and the engine's own `displacements` actually
// return; only the counts matter here, but using the real shape keeps the test
// honest about where the input comes from.
const bump = (player, pegIndex = 0) => ({ player, pegIndex, fromPosition: 10 });
const friendlyBump = (player, pegIndex = 0) => ({
  player, pegIndex, fromPosition: 10, toPosition: 3,
  friendly: true, byPlayer: 0, byPegIndex: 0,
});

describe('announcementsFor', () => {
  it('says nothing about an ordinary move', () => {
    expect(announcementsFor({})).toEqual([]);
    expect(announcementsFor({ bumps: [], friendly: [], isJoker: false })).toEqual([]);
  });

  it('does not announce a single plain bump — the peg flying home already says it', () => {
    expect(announcementsFor({ bumps: [bump(1)] })).toEqual([]);
  });

  it('announces a joker, which has no animation of its own to watch', () => {
    expect(kinds(announcementsFor({ isJoker: true, bumps: [bump(1)] }))).toEqual(['joker']);
  });

  it('announces a partner bump', () => {
    expect(kinds(announcementsFor({ friendly: [friendlyBump(2)] }))).toEqual(['partnerBump']);
  });

  it('announces a double play when two pegs are displaced by one card', () => {
    // The cascade case: a friendly bump onto an entrance an opponent was sitting on.
    expect(kinds(announcementsFor({ bumps: [bump(1)], friendly: [friendlyBump(2)] })))
      .toEqual(['partnerBump', 'doublePlay']);
    // Two knock-backs count too — the rule is "how many pegs moved", not "which
    // rule moved them".
    expect(kinds(announcementsFor({ bumps: [bump(1), bump(3)] }))).toEqual(['doublePlay']);
  });

  it('stacks all three when one card manages all three', () => {
    expect(kinds(announcementsFor({ isJoker: true, bumps: [bump(1)], friendly: [friendlyBump(2)] })))
      .toEqual(['joker', 'partnerBump', 'doublePlay']);
  });

  it('gives every announcement text and a colour to render with', () => {
    for (const a of Object.values(ANNOUNCEMENTS)) {
      expect(a.text).toBeTruthy();
      expect(a.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(a.kind).toBeTruthy();
    }
  });

  it('keeps the banners on screen long enough to read', () => {
    expect(ANNOUNCE_MS).toBeGreaterThanOrEqual(1000);
    expect(TAUNT_MS).toBeGreaterThanOrEqual(1000);
    expect(TAUNT_TEXT).toBe('@$#*!');
  });
});

describe('isSpecialPlay', () => {
  it('is false for an ordinary move, which is what keeps the game brisk', () => {
    expect(isSpecialPlay({})).toBe(false);
    expect(isSpecialPlay({ bumps: [], friendly: [], isJoker: false })).toBe(false);
  });

  it('counts a plain knock-back, which raises no banner but is still an event', () => {
    // The one place this is deliberately wider than announcementsFor: a peg has
    // just been sent the length of the board back to start, and that earns the
    // slowed fly-back and the pause even though nothing is captioned.
    expect(announcementsFor({ bumps: [bump(1)] })).toEqual([]);
    expect(isSpecialPlay({ bumps: [bump(1)] })).toBe(true);
  });

  it('counts a joker and a partner bump', () => {
    expect(isSpecialPlay({ isJoker: true })).toBe(true);
    expect(isSpecialPlay({ friendly: [friendlyBump(2)] })).toBe(true);
  });

  it('is true for anything that earns a banner', () => {
    const cases = [
      { isJoker: true },
      { friendly: [friendlyBump(2)] },
      { bumps: [bump(1)], friendly: [friendlyBump(2)] },
      { bumps: [bump(1), bump(3)] },
    ];
    for (const c of cases) {
      expect(announcementsFor(c).length).toBeGreaterThan(0);
      expect(isSpecialPlay(c)).toBe(true);
    }
  });
});

describe('the partner-bump exchange', () => {
  it('is a call and an answer', () => {
    expect(THANKS_TEXT).toBe('Thanks!');
    expect(WELCOME_TEXT).toBe("You're welcome!");
  });

  // The reply is a beat, not a second bubble after the first has gone: both
  // pegs have to be on screen together for the exchange to read as one.
  it('replies well before the first bubble expires', () => {
    expect(REPLY_MS).toBeGreaterThan(0);
    expect(REPLY_MS).toBeLessThan(TAUNT_MS / 2);
  });
});

describe('the knock-back exchange', () => {
  // Same shape as the partner exchange: the victim swears, the culprit gloats a
  // beat later, and both are on screen together.
  it('gives the bumping peg the last word', () => {
    expect(TAUNT_TEXT).toBe('@$#*!');
    expect(GLOAT_TEXT).toBe('Hee hee!');
    expect(REPLY_MS).toBeLessThan(TAUNT_MS);
  });
});
