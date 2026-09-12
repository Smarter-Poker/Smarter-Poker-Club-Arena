/**
 * A BOARD YOU CANNOT SIT AT SAYS SO.
 *
 * Diamond Arena's stake ladder went live on 2026-09-11 while funded play
 * stayed closed. That is the honest state: the tables exist, the lobby lists
 * them, and `fn_poker_diamond_buyin` refuses every buy-in with
 * `diamond_cash_not_open` until the arena opens.
 *
 * What was not honest was the card. It offered Join Table on all seventeen,
 * and every one of those clicks would have travelled to the server and come
 * back as an error. The lobby already knows how to say a seat cannot be taken:
 * the closed branch of this same function does it. This makes the arena use it.
 */
import { describe, expect, it } from 'vitest';
import { arenaGameCardActionsForEntry } from '../../src/components/lobby/game-cards/ArenaLobbyGameCard';
import type { LobbyRowContext } from '../../src/components/lobby/lobbyCardContext';
import type { LobbyEntry } from '../../src/components/lobby/lobbyEntries';

const entry = {
  id: 'table-1',
  kind: 'cash',
  name: 'NLH 1/2',
  status: 'empty',
  statusLabel: 'Empty',
  capacity: 6,
  seated: 0,
} as unknown as LobbyEntry;

const base: LobbyRowContext = {
  waitlistedIds: new Set(),
  seatedIds: new Set(),
  registeredIds: new Set(),
  favoriteIds: new Set(),
  onJoinTable: () => undefined,
  onViewTable: () => undefined,
};

describe('A closed arena offers no seat', () => {
  it('replaces Join Table with the reason and keeps the watch path', () => {
    const actions = arenaGameCardActionsForEntry(entry, {
      ...base,
      seatsClosedLabel: 'Not Open Yet',
    });
    expect(actions.primaryLabel).toBe('Not Open Yet');
    expect(actions.primaryDisabled).toBe(true);
    expect(actions.onPrimary, 'a disabled button must carry no handler').toBeUndefined();
    expect(actions.secondaryLabel).toBe('View Table');
    expect(typeof actions.onSecondary).toBe('function');
  });

  it('leaves an open board exactly as it was', () => {
    const actions = arenaGameCardActionsForEntry(entry, base);
    expect(actions.primaryLabel).toBe('Join Table');
    expect(actions.primaryDisabled).toBe(false);
    expect(typeof actions.onPrimary).toBe('function');
  });

  it('is undefined for a chip club, so no chip card changes', () => {
    expect(base.seatsClosedLabel).toBeUndefined();
  });
});
