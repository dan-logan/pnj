# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A digital implementation of the Pegs and Jokers board game built with React, Vite, and Tailwind CSS. Single-player game where you (Yellow) play against 3 AI opponents (Blue, Pink, Green).

## Commands

- `npm install` - Install dependencies
- `npm run dev` - Start development server
- `npm run build` - Build for production (outputs to `dist/`)
- `npm run preview` - Preview production build locally

## Architecture

This is a single-component React application:

- **src/PegsAndJokers.jsx** - The entire game logic and UI (~1650 lines). Contains:
  - Game state management via React hooks
  - Card deck creation and shuffling
  - Move validation logic for all card types
  - AI player logic with scoring heuristics (prioritizes moves that advance toward home, avoids vulnerable positions)
  - SVG-based board rendering
  - 4 players, 5 pegs each, 72-space track (18 per side)

- **src/main.jsx** - React entry point
- **src/index.css** - Tailwind imports only

## Game Logic Key Concepts

- Track positions: 0-71 (18 spaces per side × 4 sides)
- Start position: `player * 18 + 8` (position 8 on each player's side)
- Home entrance: `player * 18 + 3` (position 3 on each player's side)
- Cards A/J/Q/K allow moving from start; 7 can split forward; 8 moves backward; 9 must split (forward + backward); Joker bumps opponent

## Deployment

GitHub Actions automatically deploys to GitHub Pages on push to `main`. The workflow is in `.github/workflows/deploy.yml`.
