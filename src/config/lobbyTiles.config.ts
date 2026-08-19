/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY TILES CONFIG — Bottom Row Tile Definitions
 * ═══════════════════════════════════════════════════════════════════════════════
 * Centralized configuration for the 5 bottom-row holographic tiles.
 * Keyboard shortcuts map numbers 1-5 to these tiles.
 */

import { MEDIA_BASE } from '../utils/mediaBase';

const BASE = MEDIA_BASE;

export interface LobbyTile {
  img: string;
  alt: string;
  route: string | null; // null = custom handler
  shortcutKey: string; // keyboard shortcut
}

const LOBBY_TILES: LobbyTile[] = [
  {
    img: `${BASE}images/tiles/daily-challenges.webp`,
    alt: 'Daily Challenges',
    route: '/challenges',
    shortcutKey: '1',
  },
  {
    img: `${BASE}images/tiles/player-stats.webp`,
    alt: 'Player Stats',
    route: '/stats',
    shortcutKey: '2',
  },
  {
    img: `${BASE}images/tiles/leaderboards.webp`,
    alt: 'Leaderboards',
    route: '/leaderboard',
    shortcutKey: '3',
  },
  { img: `${BASE}images/tiles/cashier.webp`, alt: 'Cashier', route: null, shortcutKey: '4' }, // Custom — needs last-club logic
  {
    img: `${BASE}images/tiles/marketplace.webp`,
    alt: 'Marketplace',
    route: null,
    shortcutKey: '5',
  }, // Custom — navigate to marketplace
];

export default LOBBY_TILES;
