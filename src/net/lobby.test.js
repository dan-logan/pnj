import { describe, it, expect } from 'vitest';
import {
  seatForUid,
  toMillis,
  toLobbyRow,
  buildRemoteRows,
  sortLobbyRows,
  countWaitingOnMe,
  relativeTime,
} from './lobby.js';
import { STATUS } from './protocol.js';

const meta = (over = {}) => ({
  id: 'g1',
  hostUid: 'host',
  guestUid: 'guest',
  code: 'ABC234',
  mode: 'partners',
  status: STATUS.ACTIVE,
  currentPlayer: 1, // parked on an AI seat, as always after a publish
  waitingOn: 0,
  winner: null,
  updatedAt: 1_000_000,
  ...over,
});

describe('seatForUid', () => {
  it('maps host to 0, guest to 2, otherwise null', () => {
    expect(seatForUid(meta(), 'host')).toBe(0);
    expect(seatForUid(meta(), 'guest')).toBe(2);
    expect(seatForUid(meta(), 'stranger')).toBe(null);
  });
});

describe('toMillis', () => {
  it('handles numbers, Timestamps, {seconds}, Dates, and null', () => {
    expect(toMillis(1234)).toBe(1234);
    expect(toMillis({ toMillis: () => 5000 })).toBe(5000);
    expect(toMillis({ seconds: 2, nanoseconds: 500_000_000 })).toBe(2500);
    expect(toMillis(new Date(7000))).toBe(7000);
    expect(toMillis(null)).toBe(0);
  });
});

describe('toLobbyRow — "your turn" is waitingOn === seat, never currentPlayer', () => {
  it('is your turn for the host when waitingOn is seat 0', () => {
    const row = toLobbyRow(meta({ waitingOn: 0 }), { myUid: 'host' });
    expect(row.seat).toBe(0);
    expect(row.yourTurn).toBe(true);
    // The naive test would be false: currentPlayer is 1, never 0.
    expect(meta().currentPlayer === row.seat).toBe(false);
  });

  it('is NOT your turn when waitingOn is the partner seat', () => {
    const row = toLobbyRow(meta({ waitingOn: 2 }), { myUid: 'host' });
    expect(row.yourTurn).toBe(false);
  });

  it('is the guest turn when waitingOn is seat 2', () => {
    const row = toLobbyRow(meta({ waitingOn: 2 }), { myUid: 'guest' });
    expect(row.seat).toBe(2);
    expect(row.yourTurn).toBe(true);
  });

  it('a finished game is never "your turn"', () => {
    const row = toLobbyRow(meta({ status: STATUS.FINISHED, winner: 0, waitingOn: 0 }), { myUid: 'host' });
    expect(row.finished).toBe(true);
    expect(row.yourTurn).toBe(false);
  });

  it('a lobby (undealt) game is never "your turn"', () => {
    const row = toLobbyRow(meta({ status: STATUS.LOBBY, waitingOn: 0 }), { myUid: 'host' });
    expect(row.lobby).toBe(true);
    expect(row.yourTurn).toBe(false);
  });

  it('uses the local nickname when present, else the code', () => {
    expect(toLobbyRow(meta(), { myUid: 'host', local: { label: 'Sara' } }).label).toBe('Sara');
    expect(toLobbyRow(meta(), { myUid: 'host' }).label).toBe('ABC234');
  });
});

describe('buildRemoteRows', () => {
  const rows = () =>
    buildRemoteRows(
      [
        meta({ id: 'a', waitingOn: 2, updatedAt: 100 }), // host: not my turn
        meta({ id: 'b', waitingOn: 0, updatedAt: 200 }), // host: my turn, older
        meta({ id: 'c', waitingOn: 0, updatedAt: 500 }), // host: my turn, newest
        meta({ id: 'd', status: STATUS.FINISHED, winner: 0, updatedAt: 999 }),
        meta({ id: 'e', waitingOn: 0, updatedAt: 300 }), // archived → dropped
      ],
      { myUid: 'host', localById: { e: { archived: true } } }
    );

  it('drops archived games', () => {
    expect(rows().map((r) => r.id)).not.toContain('e');
  });

  it('orders your-turn games first (newest first), then others, then finished', () => {
    expect(rows().map((r) => r.id)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('countWaitingOnMe — the badge', () => {
  it('counts only active games whose next human seat is mine', () => {
    const rows = buildRemoteRows(
      [
        meta({ id: 'a', waitingOn: 0 }), // mine
        meta({ id: 'b', waitingOn: 0 }), // mine
        meta({ id: 'c', waitingOn: 2 }), // partner's
        meta({ id: 'd', status: STATUS.FINISHED, winner: 0, waitingOn: 0 }), // finished
        meta({ id: 'e', status: STATUS.LOBBY, waitingOn: 0 }), // not dealt
      ],
      { myUid: 'host' }
    );
    expect(countWaitingOnMe(rows)).toBe(2);
  });

  it('is zero when nothing is waiting on you', () => {
    const rows = buildRemoteRows([meta({ waitingOn: 2 })], { myUid: 'host' });
    expect(countWaitingOnMe(rows)).toBe(0);
  });
});

describe('relativeTime', () => {
  const now = 10_000_000_000;
  it('renders coarse buckets with correct pluralisation', () => {
    expect(relativeTime(now, now)).toBe('just now');
    expect(relativeTime(now - 60_000, now)).toBe('1 minute ago');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hour ago');
    expect(relativeTime(now - 3 * 60 * 60_000, now)).toBe('3 hours ago');
    expect(relativeTime(now - 48 * 60 * 60_000, now)).toBe('2 days ago');
  });
  it('is empty for a missing timestamp', () => {
    expect(relativeTime(null, now)).toBe('');
  });
});
