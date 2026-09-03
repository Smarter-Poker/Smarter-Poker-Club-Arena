import type { CSSProperties } from 'react';
import type { LobbyEntry, RuleMedallion } from '../lobbyEntries';

export type ArenaGameFamily = 'mtt' | 'nlh' | 'plo' | 'spins' | 'heads-up';
export type ArenaGamePresentation = 'desktop' | 'mobile';
export type ArenaGameSkinId = string;

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
  primaryTone?: 'blue' | 'green' | 'gold' | 'red' | 'neutral';
  primaryDisabled?: boolean;
  busy?: boolean;
  onPrimary?: () => void;
  onSecondary?: () => void;
}

export interface ArenaGameCardZoneDefinition {
  /** Logical slot order. Renderers may also target the stable data-zone name. */
  order: number;
  gridArea?: string;
  align?: CSSProperties['alignSelf'];
  maxLines?: number;
}

export interface ArenaGameCardPresentationTemplate {
  asset: string;
  aspectRatio: string;
  minWidth: number;
  layout: string;
  zones: Record<string, ArenaGameCardZoneDefinition>;
}

export interface ArenaGameCardSkin {
  id: ArenaGameSkinId;
  family: ArenaGameFamily;
  version: number;
  name: string;
  lifecycle: 'draft' | 'preview' | 'approved' | 'deprecated';
  desktop: ArenaGameCardPresentationTemplate;
  mobile: ArenaGameCardPresentationTemplate;
  statusSlots: readonly string[];
  actionSlots: readonly ('primaryAction' | 'secondaryAction')[];
  badgeSlots: readonly string[];
  ruleSlots: readonly string[];
  supportedStates: readonly ArenaGameStatus[];
  supportedActions: readonly string[];
  dynamicTextRules: Readonly<
    Record<string, { maxLines?: number; overflow: 'clip' | 'ellipsis' | 'wrap' }>
  >;
  fallbackSkin?: ArenaGameSkinId;
}

export interface ArenaGameCardFamilyRegistry {
  family: ArenaGameFamily;
  defaultSkin: ArenaGameSkinId;
  fallbackSkin: ArenaGameSkinId;
  requiredZones: readonly string[];
  skins: Readonly<Record<ArenaGameSkinId, ArenaGameCardSkin>>;
}

export type ArenaGameCardTemplateRegistry = Readonly<
  Record<ArenaGameFamily, ArenaGameCardFamilyRegistry>
>;

export interface ResolveArenaGameCardTemplateInput {
  family: ArenaGameFamily;
  /** Explicit per-card override. Highest priority. */
  skin?: ArenaGameSkinId | null;
  /** Optional future club-level override. */
  clubSkin?: ArenaGameSkinId | null;
  presentation?: ArenaGamePresentation;
  viewportWidth?: number;
  status?: ArenaGameStatus;
  /** Test/development injection only; production uses the canonical registry. */
  registry?: ArenaGameCardTemplateRegistry;
}

export interface ResolvedArenaGameCardTemplate {
  family: ArenaGameFamily;
  skinId: ArenaGameSkinId;
  skin: ArenaGameCardSkin;
  presentation: ArenaGamePresentation;
  template: ArenaGameCardPresentationTemplate;
  requestedSkin?: ArenaGameSkinId;
  didFallback: boolean;
}

export interface ArenaGameCardTemplateValidationIssue {
  family: ArenaGameFamily;
  skinId?: ArenaGameSkinId;
  message: string;
}
