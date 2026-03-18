/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * LOBBY TILES CONFIG — Bottom Row Tile Definitions
 * ═══════════════════════════════════════════════════════════════════════════════
 * Centralized configuration for the 5 bottom-row holographic tiles.
 * Keyboard shortcuts map numbers 1-5 to these tiles.
 */

const BASE = import.meta.env.BASE_URL;

export interface LobbyTile {
  img: string;
  alt: string;
  route: string | null; // null = custom handler
  shortcutKey: string; // keyboard shortcut
}

const LOBBY_TILES: LobbyTile[] = [
  {
    img: `${BASE}images/tiles/daily-challenges.jpg`,
    alt: 'Daily Challenges',
    route: '/profile',
    shortcutKey: '1',
  },
  {
    img: `${BASE}images/tiles/player-stats.jpg`,
    alt: 'Player Stats',
    route: '/profile',
    shortcutKey: '2',
  },
  {
    img: `${BASE}images/tiles/leaderboards.jpg`,
    alt: 'Leaderboards',
    route: '/leaderboard',
    shortcutKey: '3',
  },
  { img: `${BASE}images/tiles/cashier.jpg`, alt: 'Cashier', route: null, shortcutKey: '4' }, // Custom — needs last-club logic
  { img: `${BASE}images/tiles/marketplace.jpg`, alt: 'Marketplace', route: null, shortcutKey: '5' }, // Custom — navigate to marketplace
];

export default LOBBY_TILES;
