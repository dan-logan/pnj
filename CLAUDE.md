# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A digital implementation of the Pegs and Jokers board game built with React, Vite, and Tailwind CSS. Single-player game where you (Yellow) play against 3 AI opponents (Blue, Pink, Green).

## Commands

- `npm install` - Install dependencies
- `npm run dev` - Start development server
- `npm run build` - Build for production (outputs to `dist/`)
- `npm run preview` - Preview production build locally
- `npm test` - Run the Vitest suite once
- `npm run test:watch` - Run tests in watch mode

## Architecture

The rules engine is pure JavaScript (no React), separated from the UI so it can be unit-tested and reused:

- **src/game/constants.js** - Card values, board dimensions (72-space track, 18 per side), player colors/names
- **src/game/deck.js** - Deck creation (two 52-card decks + 4 jokers), shuffling, drawing with discard-pile reshuffle
- **src/game/engine.js** - Move validation (`isValidMove`, `hasAnyValidMove`), move application (`applyMove`), win detection, animation paths, UI affordances (`getValidDestinations`, `getMovablePegs`, `findBumps`). All functions take the peg state as an argument and return new state without mutating.
- **src/game/ai.js** - AI move enumeration and scoring (`getPossibleMoves`, `findBestAIMove`); prioritizes moves that advance toward home, avoids vulnerable positions
- **src/audio.js** - Web Audio synth sound effects + `navigator.vibrate` haptics with a persisted mute setting; all no-ops outside a browser
- **src/PegsAndJokers.jsx** - React component: game state via hooks, turn flow, input handlers, SVG board rendering. Move input is tap-driven: selecting a card glows the movable pegs (`getMovablePegs`), selecting a peg with a 7/9 renders tappable ghost destination circles (`getValidDestinations`)
- **src/main.jsx** - React entry point
- **src/index.css** - Tailwind imports plus small keyframe animations for peg glow/ghost destinations

Peg state shape: a 4-element array (one per player) of 5 peg objects, each `{ location: 'start' | 'track' | 'home', position?, homePosition?, index }`.

## Testing

Tests live next to the modules they cover (`src/game/*.test.js`) and run with Vitest. They cover deck composition, move validation for every card type (including 7/9 split rules and home-corridor edge cases), bumping, win detection, and AI move selection. CI (`.github/workflows/ci.yml`) runs tests and the build on every pull request, and the deploy workflow runs tests before deploying. When changing game rules, add or update engine tests in the same change.

## Game Logic Key Concepts

- Track positions: 0-71 (18 spaces per side × 4 sides)
- Start position: `player * 18 + 8` (position 8 on each player's side)
- Home entrance: `player * 18 + 3` (position 3 on each player's side)
- Cards A/J/Q/K allow moving from start; 7 can split forward; 8 moves backward; 9 must split (forward + backward); Joker bumps opponent

## Deployment

GitHub Actions automatically deploys to GitHub Pages on push to `main`. The workflow is in `.github/workflows/deploy.yml`.
