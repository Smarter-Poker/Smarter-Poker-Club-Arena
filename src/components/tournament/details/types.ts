/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY TABS — the shared contract
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25. The eight tabs of the tournament lobby used to be eight
 * inline blocks inside one 2000-line page component. They are now eight files
 * that all accept THIS prop shape, so a tab can be rewritten, tested, or
 * lazy-loaded without touching the page.
 *
 * WHAT THE PAGE GIVES YOU vs WHAT YOU FETCH YOURSELF:
 *
 *   The page has already loaded the tournament row, the entry list and the
 *   table list, and it keeps them fresh over realtime. Use those props — a tab
 *   that re-fetches the same rows on mount makes the lobby slower and can
 *   render figures that disagree with the tab beside it.
 *
 *   Fetch your own ONLY for data no other tab needs: the union/club roster,
 *   the bounty pool ledger, an agent's downline. Do it behind an effect that
 *   is cancelled on unmount and that tolerates an empty result, because a tab
 *   showing a spinner forever is worse than a tab saying there is nothing yet.
 */

import type { Tournament } from '../../../types/database.types';
import type { UseMysteryBountyResult } from '../../../hooks/useMysteryBounty';

/**
 * SEVEN TABS. Dan 2026-08-25, verbatim: "CHIPS SHOULD BE CALLED 'RANKING'" and
 * "RANKING SHOULD BE DELETED, AS WE CONVERTED 'CHIPS' TO RANKING." The old
 * `chips` tab is the one that survived, under the name Ranking; the old
 * `ranking` tab (a TournamentStandings wrapper) is gone.
 *
 * The mystery bounty ladder is NOT an eighth tab. Dan asked Rewards to show
 * "the total bounty pool and whats left or 'still available' in the mystery
 * bounty pool", which is the same question, so the ladder renders inside
 * Rewards. See RewardsTab.
 */
export type TabId = 'detail' | 'blinds' | 'ranking' | 'entries' | 'unions' | 'tables' | 'rewards';

export const TAB_IDS: readonly TabId[] = [
  'detail',
  'blinds',
  'ranking',
  'entries',
  'unions',
  'tables',
  'rewards',
];

export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'detail', label: 'Detail' },
  { id: 'blinds', label: 'Blinds' },
  { id: 'ranking', label: 'Ranking' },
  { id: 'entries', label: 'Entries' },
  { id: 'unions', label: 'Unions' },
  { id: 'tables', label: 'Tables' },
  { id: 'rewards', label: 'Rewards' },
];

/**
 * Ids that used to exist and can still be asked for - from a bookmark, a shared
 * link, or anything that stored a tab id before the rename. `chips` IS Ranking
 * now, so it must land there rather than on a blank page; `payouts` was in the
 * union before Rewards absorbed it; `mystery` was a conditional tab that the
 * Rewards tab now carries. Anything else, including an empty string, opens
 * Detail.
 */
const LEGACY_TAB_IDS: Record<string, TabId> = {
  chips: 'ranking',
  payouts: 'rewards',
  mystery: 'rewards',
};

/** The only way a tab id enters the lobby. Never throws, never returns junk. */
export function normaliseTabId(raw: string | null | undefined): TabId {
  const key = (raw || '').trim().toLowerCase();
  if ((TAB_IDS as readonly string[]).includes(key)) return key as TabId;
  return LEGACY_TAB_IDS[key] ?? 'detail';
}

/** One registered player, as the lobby understands them. */
export interface TournamentEntry {
  id: string;
  user_id: string;
  username: string;
  avatar_url: string | null;
  /** Finishing position once eliminated; absent while still playing. */
  position?: number;
  chips?: number;
  status: 'registered' | 'playing' | 'eliminated' | 'finished' | 'winner';
  table_id?: string | null;
  /** Registration order source. May be absent on very old rows. */
  created_at?: string | null;
  rebuys?: number;
  add_ons?: number;
  /** Short public player id shown in Entries. */
  player_code?: string | null;
}

/** One table in the event. */
export interface TournamentTable {
  id: string;
  name: string;
  status: string;
  max_players: number;
  current_players: number;
  small_blind: number;
  big_blind: number;
}

/** One level of the blind structure, already normalised to `duration`. */
export interface NormalisedBlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  /** Minutes. Zero means the row never carried one — show a dash, not "0m". */
  duration: number;
  isBreak: boolean;
}

/**
 * Every tab receives exactly this. Nothing here is optional-by-accident: an
 * absent `currentUserId` means nobody is signed in, and an empty `entries`
 * means the field is genuinely empty, not that it is still loading — the page
 * does not render a tab until its first load has settled.
 */
export interface TournamentTabProps {
  tournament: Tournament;
  entries: TournamentEntry[];
  tables: TournamentTable[];
  blindLevels: NormalisedBlindLevel[];
  /** Signed-in player, for "your position" and hero highlighting. */
  currentUserId?: string;
  /** True once this player holds an entry in this event. */
  isRegistered: boolean;

  /**
   * Open a table as a spectator (Dan 2026-08-25: "see any player and be
   * redirected to that table directly").
   *
   * Absent when nothing is watchable - a tab must treat that as "do not offer
   * the link", never as "navigate anyway". The page supplies it only while the
   * tournament is RUNNING, because a finished event's `table_id`s point at
   * closed felts.
   *
   * Ranking and Tables call `openTableAsObserver` themselves and do not need
   * this; Entries does, because it holds no navigate of its own.
   */
  onWatchPlayer?: (tableId: string) => void;

  /**
   * The mystery bounty ladder, fetched ONCE by the page from
   * `useMysteryBounty` and shared. Detail advertises the top chest off it and
   * Rewards renders the full panel from the same object, so the two surfaces
   * cannot disagree and a freezeout makes no RPC calls at all.
   *
   * Null or undefined for every event that is not a mystery bounty.
   */
  mysteryBounty?: UseMysteryBountyResult | null;

  /** Switch tabs from inside a tab (Detail sends the ladder link to Rewards). */
  onOpenTab?: (tab: TabId) => void;
}

/** Chips, always whole, always grouped. Never `padStart`. */
export function chips(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString();
}

/** Compact chips for tight columns: 1,250 -> 1.3K, 447,000 -> 447K. */
export function chipsCompact(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(v / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(v));
}

/** 1st, 2nd, 3rd, 4th... */
export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Seconds -> H:MM:SS (or M:SS under an hour). Negative clamps to zero. */
export function clockText(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Two initials for an avatar that has no image. */
export function initials(name: string | null | undefined): string {
  const clean = (name || '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
