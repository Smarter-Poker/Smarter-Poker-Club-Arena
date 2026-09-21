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
  width?: number;
  height?: number;
  preserveNativeRatio?: boolean;
  portalStatus?: string;
}

const LOBBY_TILES: LobbyTile[] = [
  {
    img: `${BASE}images/tiles/daily-challenges-v9.webp`,
    alt: 'Daily Challenges',
    route: '/challenges',
    shortcutKey: '1',
    width: 1024,
    height: 1536,
    preserveNativeRatio: true,
    portalStatus: 'Open Challenge Vault',
  },
  {
    img: `${BASE}images/tiles/leaderboards-v8.jpg`,
    alt: 'Leaderboards',
    route: '/leaderboard',
    shortcutKey: '2',
  },
  {
    img: `${BASE}images/tiles/player-stats-v9.png`,
    alt: 'Player Stats',
    route: '/stats',
    shortcutKey: '3',
  },
  { img: `${BASE}images/tiles/cashier-v8.jpg`, alt: 'Cashier', route: null, shortcutKey: '4' }, // Custom — needs last-club logic
  {
    img: `${BASE}images/tiles/marketplace-v8.jpg`,
    alt: 'Marketplace',
    route: null,
    shortcutKey: '5',
  }, // Custom — navigate to marketplace
];

export default LOBBY_TILES;
