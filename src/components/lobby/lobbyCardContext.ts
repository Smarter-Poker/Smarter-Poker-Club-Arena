import type { LobbyEntry } from './lobbyEntries';

export interface LobbyRowContext {
  waitlistedIds: Set<string>;
  seatedIds: Set<string>;
  registeredIds: Set<string>;
  favoriteIds: Set<string>;
  onRegister?: (entry: LobbyEntry) => void;
  onUnregister?: (entry: LobbyEntry) => void;
  onSpinJoin?: (entry: LobbyEntry, variant: 'spin' | 'sng') => void;
  onJoinTable?: (entry: LobbyEntry) => void;
  onViewTable?: (entry: LobbyEntry) => void;
  onToggleFavorite?: (tableId: string, next: boolean) => void;
  onWaitlistToggle?: (tableId: string, joining: boolean) => void;
  spinTopTierLive?: boolean;
  actionBusy?: boolean;
}
export type LobbyPlayerState = 'seated' | 'waitlisted' | 'registered' | null;

export function lobbyPlayerStateOf(entry: LobbyEntry, ctx: LobbyRowContext): LobbyPlayerState {
  if (entry.kind === 'cash') {
    /* A must-move game's row is its Main 1 (R10), but a player in the game
       may be sitting on Main 2 or the feeder. `seatedIds` carries the GAME id
       for every cluster seat (ClubHomePage.loadMyGameStates), so a seat
       anywhere in the game reads Return To Game rather than offering a Join
       to somebody who is already playing (must-move audit, 2026-09-09). */
    if (ctx.seatedIds.has(entry.id) || (entry.game && ctx.seatedIds.has(entry.game.id)))
      return 'seated';
    if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
    return null;
  }
  if (ctx.seatedIds.has(entry.id)) return 'seated';
  if (ctx.registeredIds.has(entry.id)) return 'registered';
  if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
  return null;
}
