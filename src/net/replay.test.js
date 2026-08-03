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
