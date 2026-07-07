import { describe, it, expect } from 'vitest';
import { createDeck, shuffle, drawCard } from './deck.js';

const card = (rank, suit = '♠', id = `${rank}${suit}test`) => ({ rank, suit, id });

describe('createDeck', () => {
  it('contains 108 cards (two 52-card decks plus 4 jokers)', () => {
    expect(createDeck()).toHaveLength(108);
  });

  it('contains exactly 4 jokers', () => {
    const jokers = createDeck().filter(c => c.rank === 'JOKER');
    expect(jokers).toHaveLength(4);
  });

  it('contains 8 of each regular rank (2 decks x 4 suits)', () => {
    const deck = createDeck();
    for (const rank of ['A', '2', '7', '8', '9', '10', 'J', 'Q', 'K']) {
      expect(deck.filter(c => c.rank === rank)).toHaveLength(8);
    }
  });

  it('gives every card a unique id', () => {
    const ids = new Set(createDeck().map(c => c.id));
    expect(ids.size).toBe(108);
  });
});

describe('shuffle', () => {
  it('preserves the multiset of cards', () => {
    const original = createDeck();
    const shuffled = shuffle(original);
    expect(shuffled).toHaveLength(original.length);
    expect(new Set(shuffled.map(c => c.id))).toEqual(new Set(original.map(c => c.id)));
  });

  it('does not mutate its input', () => {
    const original = [card('A'), card('2'), card('3'), card('4')];
    const snapshot = [...original];
    shuffle(original);
    expect(original).toEqual(snapshot);
  });
});

describe('drawCard', () => {
  it('draws the top card without mutating the input deck', () => {
    const deck = [card('A'), card('2'), card('3')];
    const piles = [[], [], [], []];
    const { card: drawn, newDeck, newDiscardPiles } = drawCard(deck, piles);
    expect(drawn.rank).toBe('3');
    expect(newDeck).toHaveLength(2);
    expect(deck).toHaveLength(3); // input untouched
    expect(newDiscardPiles).toBe(piles);
  });

  it('reshuffles all discard piles into a fresh deck when the deck is empty', () => {
    const piles = [[card('A', '♠', 'a')], [card('2', '♥', 'b')], [], [card('3', '♦', 'c')]];
    const { card: drawn, newDeck, newDiscardPiles } = drawCard([], piles);
    expect(drawn).not.toBeNull();
    expect(newDeck).toHaveLength(2); // 3 discards, 1 drawn
    expect(newDiscardPiles).toEqual([[], [], [], []]);
    const allIds = new Set([drawn.id, ...newDeck.map(c => c.id)]);
    expect(allIds).toEqual(new Set(['a', 'b', 'c']));
  });

  it('returns null when both the deck and all discard piles are empty', () => {
    const { card: drawn, newDeck } = drawCard([], [[], [], [], []]);
    expect(drawn).toBeNull();
    expect(newDeck).toEqual([]);
  });
});
