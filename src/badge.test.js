import { describe, it, expect, vi } from 'vitest';
import { isBadgeSupported, syncAppBadge } from './badge.js';

// A navigator that supports badging, with both calls recorded.
const fakeNav = (over = {}) => ({
  setAppBadge: vi.fn(() => Promise.resolve()),
  clearAppBadge: vi.fn(() => Promise.resolve()),
  ...over,
});

describe('isBadgeSupported', () => {
  it('is true only when both badge methods exist', () => {
    expect(isBadgeSupported(fakeNav())).toBe(true);
    expect(isBadgeSupported({ setAppBadge: vi.fn() })).toBe(false);
    expect(isBadgeSupported({ clearAppBadge: vi.fn() })).toBe(false);
    expect(isBadgeSupported({})).toBe(false);
  });

  it('is false with no navigator at all (node, tests, SSR)', () => {
    expect(isBadgeSupported(null)).toBe(false);
  });
});

describe('syncAppBadge', () => {
  it('sets the badge to the count when games are waiting', () => {
    const nav = fakeNav();
    expect(syncAppBadge(3, nav)).toBe(true);
    expect(nav.setAppBadge).toHaveBeenCalledWith(3);
    expect(nav.clearAppBadge).not.toHaveBeenCalled();
  });

  // A badge showing "0" and no badge are different things to the OS, and
  // nothing waiting on you must render as no badge.
  it('clears the badge at zero rather than setting zero', () => {
    const nav = fakeNav();
    expect(syncAppBadge(0, nav)).toBe(true);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(nav.setAppBadge).not.toHaveBeenCalled();
  });

  it('no-ops where badging is unsupported (Firefox, desktop Safari)', () => {
    expect(syncAppBadge(2, {})).toBe(false);
    expect(syncAppBadge(2, null)).toBe(false);
  });

  it('no-ops outside a browser, where there is no navigator to resolve', () => {
    // Vitest runs in node, so the ambient navigator is absent or badge-less.
    expect(syncAppBadge(1)).toBe(false);
  });

  // The badge is cosmetic; no failure mode of it may reach the game.
  it('swallows a rejected badge promise', async () => {
    const nav = fakeNav({ setAppBadge: vi.fn(() => Promise.reject(new Error('not installed'))) });
    expect(syncAppBadge(1, nav)).toBe(true);
    await Promise.resolve(); // let the rejection settle; an unhandled one fails the run
  });

  it('swallows a synchronous throw', () => {
    const nav = fakeNav({
      setAppBadge: vi.fn(() => {
        throw new Error('permission revoked');
      }),
    });
    expect(syncAppBadge(1, nav)).toBe(false);
  });

  it('tolerates a badge API that returns nothing instead of a promise', () => {
    const nav = fakeNav({ setAppBadge: vi.fn(() => undefined) });
    expect(syncAppBadge(1, nav)).toBe(true);
  });
});
