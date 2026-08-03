import { describe, it, expect } from 'vitest';
import { seedReplay, appendReplayFrame } from './replay.js';

describe('seedReplay', () => {
  it('copies the wire frames in order', () => {
    const wire = [{ player: 0, description: 'a' }, { player: 1, description: 'b' }];
    expect(seedReplay(wire)).toEqual(wire);
  });

  it('is defensive against a missing or malformed replay', () => {
    expect(seedReplay(undefined)).toEqual([]);
    expect(seedReplay(null)).toEqual([]);
    expect(seedReplay('nope')).toEqual([]);
  });

  it('returns a fresh array, not the same reference (no aliasing the wire payload)', () => {
    const wire = [{ player: 0 }];
    expect(seedReplay(wire)).not.toBe(wire);
  });
});

describe('appendReplayFrame — wire frames before locally-simulated ones', () => {
  it('appends after whatever is already buffered', () => {
    const wireFrame = { player: 0, description: "partner's move" };
    const aiFrame = { player: 1, description: "Blue's move" };
    let buf = seedReplay([wireFrame]);
    buf = appendReplayFrame(buf, aiFrame);
    expect(buf).toEqual([wireFrame, aiFrame]);
  });

  it('never reorders — multiple appends stay in the order they were simulated', () => {
    let buf = seedReplay([]);
    buf = appendReplayFrame(buf, { player: 1, description: 'first' });
    buf = appendReplayFrame(buf, { player: 3, description: 'second' });
    expect(buf.map(f => f.description)).toEqual(['first', 'second']);
  });

  it('does not mutate the array passed in', () => {
    const original = [{ player: 0 }];
    const next = appendReplayFrame(original, { player: 1 });
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});

// Regression test for a real bug: PegsAndJokers.jsx used to build the wire
// `replay` payload from the same buffer used for local display (seed +
// locally-simulated frames). The seed is always the *recipient's own earlier
// move* — with exactly two humans strictly alternating publishes, whoever a
// client is about to publish to is exactly whoever its current seed
// originated from. Reusing that buffer re-forwards the recipient's own move
// back to them, and the next hop does it again, so the replay grows to "the
// whole game" after a few rounds. The fix keeps two buffers: `display` (seed
// + own, for what this client should watch) and `own` (never seeded, only
// ever appended to — what this client actually publishes). This test
// simulates several hops between two players and asserts `own` never grows
// past what happened since the *last* hand-off, however many rounds pass.
describe('two-buffer discipline across multiple hops (regression)', () => {
  it('keeps the wire-published buffer bounded to one round, not the whole game', () => {
    // A minimal stand-in for what PegsAndJokers.jsx does at each hop.
    function adopt(wireFrames) {
      return { display: seedReplay(wireFrames), own: [] };
    }
    function simulate(buffers, frame) {
      return { display: appendReplayFrame(buffers.display, frame), own: appendReplayFrame(buffers.own, frame) };
    }
    function publish(buffers, myOwnMoveFrame) {
      // What commitTurn actually sends: own + this move, never the seed.
      return appendReplayFrame(buffers.own, myOwnMoveFrame);
    }

    // Round 1: host moves, guest adopts, simulates Blue, then makes their own move.
    let hostBuffers = adopt([]);
    const hostMove1 = { player: 0, description: 'Host move 1' };
    let hostWire1 = publish(hostBuffers, hostMove1); // -> guest
    expect(hostWire1).toEqual([hostMove1]);

    let guestBuffers = adopt(hostWire1);
    guestBuffers = simulate(guestBuffers, { player: 1, description: 'Blue move 1' });
    const guestMove1 = { player: 2, description: 'Guest move 1' };
    const guestWire1 = publish(guestBuffers, guestMove1); // -> host
    // Host should see exactly what happened since their move: Blue, then Guest.
    // NOT their own move1 re-included.
    expect(guestWire1).toEqual([{ player: 1, description: 'Blue move 1' }, guestMove1]);

    // Round 2: host adopts, simulates Green, makes their own second move.
    hostBuffers = adopt(guestWire1);
    hostBuffers = simulate(hostBuffers, { player: 3, description: 'Green move 1' });
    const hostMove2 = { player: 0, description: 'Host move 2' };
    const hostWire2 = publish(hostBuffers, hostMove2); // -> guest
    // Guest should see Green's move then host's second move — NOT the whole
    // history (Blue/Guest's own round-1 move must not reappear here).
    expect(hostWire2).toEqual([{ player: 3, description: 'Green move 1' }, hostMove2]);
    expect(hostWire2.length).toBe(2); // bounded — this is what regressed
  });
});
