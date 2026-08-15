import { describe, it, expect } from 'vitest';
import { announcementsFor, ANNOUNCEMENTS, TAUNT_TEXT, ANNOUNCE_MS, TAUNT_MS } from './announce.js';

const kinds = (result) => result.map(a => a.kind);

// Shapes matching what findBumps / findFriendlyBumps actually return; only the
// counts matter here, but using the real shape keeps the test honest about
// where the input comes from.
const bump = (player, pegIndex = 0) => ({ player, pegIndex, fromPosition: 10 });
const friendlyBump = (player, pegIndex = 0) => ({ player, pegIndex, fromPosition: 10, toPosition: 3 });

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
