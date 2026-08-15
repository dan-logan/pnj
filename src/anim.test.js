import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SPEED,
  SPEED_ORDER,
  SPEED_SETTINGS,
  isSpeed,
  settingsFor,
  stepMsFor,
  thinkMsFor,
  settleMsFor,
  animationsOn,
  nextSpeed,
  loadSpeed,
  saveSpeed,
} from './anim.js';

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    _data: data,
  };
};

describe('animation speeds', () => {
  it('defaults to slow — the game should be followable before it is brisk', () => {
    expect(DEFAULT_SPEED).toBe('slow');
    expect(stepMsFor(DEFAULT_SPEED)).toBe(SPEED_SETTINGS.slow.stepMs);
  });

  it('gets slower as you go down the order', () => {
    expect(stepMsFor('slow')).toBeGreaterThan(stepMsFor('normal'));
    expect(stepMsFor('normal')).toBeGreaterThan(stepMsFor('fast'));
    expect(stepMsFor('fast')).toBeGreaterThan(0);
    // The thinking pause follows the same ladder — an opponent that plays the
    // instant its turn arrives is the single hardest thing to follow, so the
    // slow pace gives you two full seconds to find the board first.
    expect(thinkMsFor('slow')).toBeGreaterThanOrEqual(2000);
    expect(thinkMsFor('slow')).toBeGreaterThan(thinkMsFor('normal'));
    expect(thinkMsFor('normal')).toBeGreaterThan(thinkMsFor('fast'));
  });

  it('gives `off` a zero step but keeps a thinking pause', () => {
    expect(stepMsFor('off')).toBe(0);
    expect(settleMsFor('off')).toBe(0);
    // With nothing animating, the pause between AI turns is the only thing
    // separating one from the next.
    expect(thinkMsFor('off')).toBeGreaterThan(0);
  });

  it('treats every speed but `off` as animations-on', () => {
    expect(animationsOn('slow')).toBe(true);
    expect(animationsOn('normal')).toBe(true);
    expect(animationsOn('fast')).toBe(true);
    expect(animationsOn('off')).toBe(false);
  });

  it('cycles through every speed and wraps', () => {
    let speed = SPEED_ORDER[0];
    const seen = [speed];
    for (let i = 0; i < SPEED_ORDER.length - 1; i++) {
      speed = nextSpeed(speed);
      seen.push(speed);
    }
    expect(seen).toEqual(SPEED_ORDER);
    expect(nextSpeed(SPEED_ORDER[SPEED_ORDER.length - 1])).toBe(SPEED_ORDER[0]);
  });

  it('falls back to the default for anything unrecognised', () => {
    expect(isSpeed('turbo')).toBe(false);
    expect(settingsFor('turbo')).toBe(SPEED_SETTINGS[DEFAULT_SPEED]);
    expect(settingsFor(undefined)).toBe(SPEED_SETTINGS[DEFAULT_SPEED]);
  });

  it('round-trips a saved preference', () => {
    const storage = fakeStorage();
    saveSpeed('fast', storage);
    expect(loadSpeed(storage)).toBe('fast');
  });

  it('ignores a junk or missing stored value', () => {
    expect(loadSpeed(fakeStorage())).toBe(DEFAULT_SPEED);
    expect(loadSpeed(fakeStorage({ 'pnj:animSpeed:v1': 'ludicrous' }))).toBe(DEFAULT_SPEED);
  });

  it('never persists a value it would refuse to load', () => {
    const storage = fakeStorage();
    saveSpeed('ludicrous', storage);
    expect(loadSpeed(storage)).toBe(DEFAULT_SPEED);
  });

  it('is a no-op without storage', () => {
    expect(loadSpeed(null)).toBe(DEFAULT_SPEED);
    expect(() => saveSpeed('fast', null)).not.toThrow();
  });

  it('survives a storage that throws (Safari private mode)', () => {
    const hostile = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(loadSpeed(hostile)).toBe(DEFAULT_SPEED);
    expect(() => saveSpeed('fast', hostile)).not.toThrow();
  });
});
