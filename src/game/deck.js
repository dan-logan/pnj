// Deck creation, shuffling, and drawing — all pure functions
import { CARD_VALUES, SUITS } from './constants.js';

export function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function createDeck() {
  const deck = [];
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of Object.keys(CARD_VALUES)) {
        if (rank !== 'JOKER') {
          deck.push({ rank, suit, id: `${rank}${suit}${d}` });
        }
      }
    }
    deck.push({ rank: 'JOKER', suit: '🃏', id: `JOKER1_${d}` });
    deck.push({ rank: 'JOKER', suit: '🃏', id: `JOKER2_${d}` });
  }
  return shuffle(deck);
}

// Draw the top card, reshuffling all discard piles into a new deck when empty.
// Returns { card, newDeck, newDiscardPiles } without mutating the inputs.
export function drawCard(currentDeck, allDiscardPiles) {
  if (currentDeck.length === 0) {
    const allDiscards = allDiscardPiles.flat();
    if (allDiscards.length === 0) {
      return { card: null, newDeck: [], newDiscardPiles: [[], [], [], []] };
    }
    const reshuffled = shuffle([...allDiscards]);
    return { card: reshuffled.pop(), newDeck: reshuffled, newDiscardPiles: [[], [], [], []] };
  }
  const newDeck = [...currentDeck];
  return { card: newDeck.pop(), newDeck, newDiscardPiles: allDiscardPiles };
}
