// Shared game constants for Pegs and Jokers

export const CARD_VALUES = {
  'A': { value: 1, canStart: true },
  '2': { value: 2, canStart: false },
  '3': { value: 3, canStart: false },
  '4': { value: 4, canStart: false },
  '5': { value: 5, canStart: false },
  '6': { value: 6, canStart: false },
  '7': { value: 7, canStart: false, canSplit: true },
  '8': { value: -8, canStart: false, backward: true },
  '9': { value: 9, canStart: false, mustSplit: true },
  '10': { value: 10, canStart: false },
  'J': { value: 11, canStart: true },
  'Q': { value: 12, canStart: true },
  'K': { value: 13, canStart: true },
  'JOKER': { value: 0, canStart: false, isJoker: true }
};

export const SUITS = ['♠', '♥', '♦', '♣'];
export const TRACK_LENGTH = 72; // 18 spaces per side * 4 sides
export const SPACES_PER_SIDE = 18;
export const NUM_PLAYERS = 4;
export const PEGS_PER_PLAYER = 5;
export const HOME_SIZE = 5; // Home corridor positions 0-4
export const HAND_SIZE = 6;
export const PLAYER_COLORS = ['#F59E0B', '#3B82F6', '#EC4899', '#10B981'];
export const PLAYER_NAMES = ['Yellow', 'Blue', 'Pink', 'Green'];
