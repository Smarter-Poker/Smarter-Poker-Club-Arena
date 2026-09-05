/**
 * GATE 6 (OPORD 1.4 s2.9, A3.6): a must-move game is joined, viewed and
 * watched as a GAME - "JOIN GAME / VIEW GAME / WATCH GAME" - because the
 * platform picks the table. A single manual table keeps "Join Table".
 *
 * Every cash action surface is rendered here against a cluster entry and
 * against a plain table, and the old words are grepped out of the game path.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arenaGameCardActionsForEntry } from '../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyEntry } from '../src/components/lobby/lobbyEntries';
import type { LobbyRowContext } from '../src/components/lobby/lobbyCardContext';

const base = (over: Partial<LobbyEntry> = {}): LobbyEntry =>
  ({
    id: 't1',
    kind: 'cash',
    name: 'NLH 1/2 Action',
    gameLabel: 'NLH',
    variantLabel: "No Limit Hold'em",
    stakesLabel: '1/2',
    stakesValue: 2,
    buyInLabel: '80 - 400',
    buyInValue: 80,
    guaranteeLabel: null,
    guaranteeValue: 0,
    startTime: null,
    startValue: Infinity,
    speedLabel: null,
    status: 'running',
    statusLabel: 'Running',
    live: true,
    players: 11,
    capacity: 0,
    rules: [],
    raw: { id: 't1', status: 'running' },
    ...over,
  }) as unknown as LobbyEntry;

const ctx = {
  seatedIds: new Set<string>(),
  waitlistedIds: new Set<string>(),
  registeredIds: new Set<string>(),
  onJoinTable: () => {},
  onViewTable: () => {},
  onWaitlistToggle: () => {},
} as unknown as LobbyRowContext;

describe('a game is joined as a game', () => {
  it('the card says Join Game / View Game for a cluster, Join Table / View Table for a manual table', () => {
    const game = arenaGameCardActionsForEntry(
      base({ game: { id: 'g', mustMove: true, template: 'action', tables: 2, state: 'live' } }),
      ctx
    );
    expect(game.primaryLabel).toBe('Join Game');
    expect(game.secondaryLabel).toBe('View Game');
    const table = arenaGameCardActionsForEntry(base({ capacity: 6, players: 3 }), ctx);
    expect(table.primaryLabel).toBe('Join Table');
    expect(table.secondaryLabel).toBe('View Table');
    const full = arenaGameCardActionsForEntry(
      base({
        status: 'full',
        capacity: 6,
        players: 6,
        game: { id: 'g', mustMove: true, template: 'action', tables: 2, state: 'live' },
      }),
      ctx
    );
    expect(full.secondaryLabel).toBe('Watch Game');
  });

  it('the row and the pre-commit panel say the same', () => {
    const row = readFileSync(resolve(__dirname, '../src/components/lobby/LobbyTable.tsx'), 'utf8');
    expect(row).toMatch(/\{game \? 'View Game' : 'View Table'\}/);
    expect(row).toMatch(/game\s*\?\s*'Return To Game'\s*:\s*'Return To Table'/);
    expect(row).toMatch(/game\s*\?\s*'Join Game'\s*:\s*'Join Table'/);
    const panel = readFileSync(
      resolve(__dirname, '../src/components/lobby/GameLobbyPanel.tsx'),
      'utf8'
    );
    expect(panel).toMatch(/label: game \? 'Join Game' : 'Join Table'/);
    expect(panel).toMatch(/label: game \? 'Return To Game' : 'Return To Table'/);
    expect(panel).toMatch(/secondaryLabel: entry\.game \? 'View Game' : 'View Table'/);
  });
});
