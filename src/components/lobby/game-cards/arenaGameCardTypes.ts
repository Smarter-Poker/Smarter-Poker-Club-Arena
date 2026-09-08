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
  /**
   * When set, the pill prints `statusLabel` verbatim in this colour instead
   * of the status's own word (2026-09-04: My Waitlists prints "#3 In Line",
   * "Next Up" and "Seat Held 0:42" in the card's own pill slot).
   */
  statusTone?: 'blue' | 'green' | 'red' | 'gold' | 'neutral';
  featured?: boolean;
  registeredByViewer?: boolean;
  rules: RuleMedallion[];
  dataState?: ArenaGameDataState;
  source?: LobbyEntry;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT AN EMPTY BAY PRINTS — one answer, for every renderer
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-02: "THE GAME CARDS SHOULD NEVER SAY UNAVAILABLE, THEY SHOULD
 * HAVE 0'S UNTIL THE CARD LOADS."
 *
 * The zones that hold a NUMBER print 0 while they wait. Everything else keeps
 * the dash, because 0 is only an honest placeholder where a count belongs - a
 * missing variant, format or start time is not zero of anything, and "0" over
 * the game type would be a worse lie than the dash it replaced.
 *
 * THIS LIVES HERE, IN THE TYPES MODULE, ON PURPOSE. It began as a private
 * constant inside ArenaGameCard's `LiveValue`, which covers the NLH, PLO, Spin
 * and Heads-Up machines - and silently missed the other two renderers:
 *
 *   MttMachine        six bays hand-rolled as `{data.buyIn || '-'}` instead of
 *                     going through LiveValue.
 *   NlhPremiumCard    the layered mobile NLH card - the one in Dan's own
 *                     screenshot - with three more of the same.
 *
 * So the first cut of the fix never reached the two card families a player is
 * most likely to be looking at on a phone. `ArenaGameCard` imports
 * NlhPremiumCard, so the shared helper cannot live there without an import
 * cycle; this module is the leaf all three already depend on, and it is where
 * the field vocabulary itself is declared.
 */
export const NUMERIC_ZONES: ReadonlySet<string> = new Set([
  'buyIn',
  'currentLevel',
  'guarantee',
  'maxPayout',
  'players',
  'registered',
  'stakes',
  'startingStack',
]);

/** The text a bay shows for `zone`, given whatever value it has (or has not). */
export function zoneText(zone: string, value?: string): string {
  return value || (NUMERIC_ZONES.has(zone) ? '0' : '-');
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
