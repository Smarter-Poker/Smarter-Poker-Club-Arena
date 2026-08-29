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
    if (ctx.seatedIds.has(entry.id)) return 'seated';
    if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
    return null;
  }
  if (ctx.seatedIds.has(entry.id)) return 'seated';
  if (ctx.registeredIds.has(entry.id)) return 'registered';
  if (ctx.waitlistedIds.has(entry.id)) return 'waitlisted';
  return null;
}
