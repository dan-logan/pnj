import { describe, it, expect } from 'vitest';
import {
  buildCreateMeta,
  buildJoinMeta,
  buildPublishMeta,
  isEcho,
  waitingSeatOf,
  STATUS,
  HOST_SEAT,
  GUEST_SEAT,
} from './protocol.js';

const NOW = 12345;

describe('buildCreateMeta — mirrors the create rule', () => {
  it('makes the creator the sole participant and host, version 0, lobby', () => {
    const meta = buildCreateMeta({ hostUid: 'h', code: 'ABC234', now: NOW });
    expect(meta.hostUid).toBe('h');
    expect(meta.guestUid).toBe(null);
    expect(meta.participants).toEqual(['h']);
    expect(meta.version).toBe(0);
    expect(meta.status).toBe(STATUS.LOBBY);
    expect(meta.mode).toBe('partners');
    expect(meta.code).toBe('ABC234');
    expect(meta.winner).toBe(null);
    expect(meta.currentPlayer).toBe(HOST_SEAT);
    expect(meta.waitingOn).toBe(HOST_SEAT);
  });
});

describe('buildJoinMeta — mirrors join rule (a)', () => {
  it('adds only the joiner, freezes the host, does not bump the version', () => {
    const before = buildCreateMeta({ hostUid: 'h', code: 'ABC234', now: NOW });
    const { meta, seat } = buildJoinMeta(before, 'g', NOW + 1);
    expect(seat).toBe(GUEST_SEAT);
    expect(meta.guestUid).toBe('g');
    expect(meta.participants).toEqual(['h', 'g']);
    expect(meta.hostUid).toBe('h');
    expect(meta.version).toBe(before.version); // claiming a seat is not a turn
    expect(meta.updatedAt).toBe(NOW + 1);
  });
});

describe('buildPublishMeta — mirrors publish rule (b)', () => {
  const active = {
    participants: ['h', 'g'],
    hostUid: 'h',
    guestUid: 'g',
    version: 3,
    status: STATUS.ACTIVE,
    winner: null,
  };

  it('advances the version by exactly one and freezes membership', () => {
    const next = buildPublishMeta(active, { currentPlayer: 1, waitingOn: 2, now: NOW });
    expect(next.version).toBe(4);
    expect(next.participants).toEqual(['h', 'g']);
    expect(next.hostUid).toBe('h');
    expect(next.guestUid).toBe('g');
    expect(next.currentPlayer).toBe(1);
    expect(next.waitingOn).toBe(2);
    expect(next.status).toBe(STATUS.ACTIVE);
  });

  it('flips to finished when a winner is set', () => {
    const next = buildPublishMeta(active, { currentPlayer: 2, waitingOn: 0, winner: 0, now: NOW });
    expect(next.winner).toBe(0);
    expect(next.status).toBe(STATUS.FINISHED);
  });

  it('honours an explicit status (initial deal → active)', () => {
    const lobby = { ...active, version: 0, status: STATUS.LOBBY };
    const next = buildPublishMeta(lobby, { currentPlayer: 0, waitingOn: 0, status: STATUS.ACTIVE, now: NOW });
    expect(next.version).toBe(1);
    expect(next.status).toBe(STATUS.ACTIVE);
  });
});

describe('isEcho — ignore your own write coming back', () => {
  it('treats a pending local write as an echo regardless of version', () => {
    expect(isEcho({ hasPendingWrites: true, version: 99 }, 3)).toBe(true);
  });

  it('treats a version you already hold (or older) as an echo', () => {
    expect(isEcho({ hasPendingWrites: false, version: 3 }, 3)).toBe(true);
    expect(isEcho({ hasPendingWrites: false, version: 2 }, 3)).toBe(true);
  });

  it('adopts a strictly higher confirmed version', () => {
    expect(isEcho({ hasPendingWrites: false, version: 4 }, 3)).toBe(false);
  });

  it('is safe with missing fields', () => {
    expect(isEcho(undefined, 3)).toBe(false);
    expect(isEcho({}, 3)).toBe(false);
  });
});

describe('waitingSeatOf', () => {
  it('returns the stored waitingOn seat', () => {
    expect(waitingSeatOf({ waitingOn: 2 })).toBe(2);
    expect(waitingSeatOf({ waitingOn: 0 })).toBe(0);
  });
  it('is null when absent', () => {
    expect(waitingSeatOf({})).toBe(null);
    expect(waitingSeatOf(null)).toBe(null);
  });
});
