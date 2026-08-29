import type { LobbyEntry, RuleMedallion } from '../lobbyEntries';

export type ArenaGameFamily = 'mtt' | 'nlh' | 'plo' | 'spin' | 'heads-up';

export type ArenaGameStatus =
  | 'open'
  | 'running'
  | 'filling'
  | 'registering'
  | 'late-reg'
  | 'full'
  | 'waitlist'
  | 'closed'
  | 'starting'
  | 'paused';

export type ArenaGameDataState = 'loading' | 'loaded' | 'updating' | 'error' | 'stale' | 'offline';

export interface ArenaGameCardData {
  id: string;
  family: ArenaGameFamily;
  title: string;
  subtitle?: string;
  gameType: string;
  stakes?: string;
  players?: string;
  buyIn?: string;
  guarantee?: string;
  registered?: string;
  startTime?: string;
  startsIn?: string;
  startingStack?: string;
  currentLevel?: string;
  currentBlinds?: string;
  waitlist?: string;
  maxPayout?: string;
  topPrize?: string;
  blindLevels?: string;
  format?: string;
  status: ArenaGameStatus;
  statusLabel: string;
  featured?: boolean;
  registeredByViewer?: boolean;
  rules: RuleMedallion[];
  dataState?: ArenaGameDataState;
  source?: LobbyEntry;
}

export interface ArenaGameCardActions {
  primaryLabel: string;
  secondaryLabel?: string;
  primaryDisabled?: boolean;
  busy?: boolean;
  onPrimary?: () => void;
  onSecondary?: () => void;
}

export interface ArenaGameCardTemplate {
  family: ArenaGameFamily;
  desktopArtwork: string;
  mobileArtwork: string;
  desktopAspectRatio: string;
  mobileAspectRatio: string;
  zones: readonly string[];
}
