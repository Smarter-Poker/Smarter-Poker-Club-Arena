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

import { compactChips } from '../../../utils/format';
import type { Tournament } from '../../../types/database.types';
import type { UseMysteryBountyResult } from '../../../hooks/useMysteryBounty';
import { computePlacePrize, prizePoolAvailableToPlaces } from '../../../lib/payoutMath';
import { UNIT_CENTS_ASSET_NOT_READ } from '../../../../server/src/tournament/tournamentUnit';
import { parsePayoutStructure } from '../../../lib/payoutStructure';

export { parsePayoutStructure } from '../../../lib/payoutStructure';
export { resolvePayoutStructure } from '../../../lib/payoutStructure';
export type { PayoutPlace, PayoutSubject } from '../../../lib/payoutStructure';

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
export type TabId =
  | 'detail'
  | 'blinds'
  | 'ranking'
  | 'entries'
  | 'unions'
  | 'tables'
  | 'rewards'
  | 'satellites';

export const TAB_IDS: readonly TabId[] = [
  'detail',
  'blinds',
  'ranking',
  'entries',
  'unions',
  'tables',
  'rewards',
  'satellites',
];

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TAB CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * Dan 2026-08-25: 'Detail' is the overview tab, 'Rewards' is payouts/bounties.
 * 'Blinds' is structure.
 */
export const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'detail', label: 'Details' },
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
  /** Exact settled prize from tournament_players; required for dealt finishes. */
  prize?: number;
  chips?: number;
  status: 'registered' | 'playing' | 'eliminated' | 'finished' | 'winner';
  table_id?: string | null;
  /** Registration order source. May be absent on very old rows. */
  created_at?: string | null;
  rebuys?: number;
  add_ons?: number;
  player_code?: string | null;
  is_satellite_qualifier?: boolean;
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

/* ═══════════════════════════════════════════════════════════════════════════
   WHO IS STILL IN — one predicate, because four tabs print this number
   ═══════════════════════════════════════════════════════════════════════════

   The 2026-08-26 audit found four different answers to the same question, on
   four tabs of the same screen:

     Ranking   !(eliminated | finished)                  counts a winner
     Tables    !(eliminated | finished)                  counts a winner
     Detail    playing | registered                      does NOT count a winner
     Rewards   registered | playing                      does NOT count a winner

   So "Remaining", "Average Stack" and "Total Chips" could differ between Detail
   and Ranking by a whole player, and Rewards' money bubble could be counted off
   a different field size than the one Ranking now prints "To The Money" from.
   Two tabs disagreeing about the same number is worse than either being wrong.

   The rule: a player is OUT when they can no longer be watched playing, which
   is `eliminated` or `finished`. A `winner` has not gone out - they have won,
   and they are the last player standing, which is a different sentence. */

/** True once this player can no longer be watched playing. */
export function isPlayerOut(entry: Pick<TournamentEntry, 'status'>): boolean {
  return entry.status === 'eliminated' || entry.status === 'finished';
}

/** True while this player still holds a stack in the event. */
export function isPlayerLive(entry: Pick<TournamentEntry, 'status'>): boolean {
  return !isPlayerOut(entry);
}

/** Chips, always whole, always grouped. Never `padStart`. */
export function chips(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return Math.round(v).toLocaleString();
}

/**
 * Compact chips, Dan's rule: 1,250 -> 1.2K, 5,000 -> 5K, 447,000 -> 447K.
 *
 * This used to be a second, competing formatter - it ROUNDED (1,250 read
 * "1.3K", overstating what a player has) and it kept the tenth on a round
 * figure ("5.0K", a decimal on a forward-facing page, which Dan forbids).
 * Both rules are wrong and both were visible on the tournament cards. There is
 * one compact formatter on this platform now; this name stays because 25 call
 * sites use it, but it delegates.
 */
export function chipsCompact(n: number | null | undefined): string {
  return compactChips(n);
}

/**
 * 1st, 2nd, 3rd, 4th...
 *
 * Guarded, because every caller feeds this a `position` off a row where the
 * column is nullable and the type is `any`. Unguarded it produced the literal
 * string "NaNth" and put it on screen (2026-08-26 audit).
 */
export function ordinal(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1) return '-';
  const i = Math.floor(v);
  const s = ['th', 'st', 'nd', 'rd'];
  const mod = i % 100;
  return `${i.toLocaleString()}${s[(mod - 20) % 10] || s[mod] || s[0]}`;
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

/* ═══════════════════════════════════════════════════════════════════════════
   THE PAYOUT STRUCTURE — parsed in ONE place
   ═══════════════════════════════════════════════════════════════════════════

   `tournaments.payout_structure` is a TEXT column holding JSON. The engine and
   database settle one canonical shape: explicit positive integer `place` and
   positive `percentage` rows. Every browser surface imports the same parser,
   so malformed or retired shapes cannot be advertised as payable ladders. */

/** Coerce anything the column might hold into a finite number. */
function finite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** How many places this event pays. Zero when no structure is published. */
export function paidPlaceCount(raw: unknown): number {
  return parsePayoutStructure(raw)?.length ?? 0;
}

/**
 * The LAST place in the money — the money bubble sits one behind it.
 *
 * A COUNT AND A PLACE NUMBER ARE NOT THE SAME THING (2026-08-29). Both callers
 * that needed the bubble were reading `paidPlaceCount`, which is a length.
 * `parsePayoutStructure` de-duplicates and sorts but does not require the
 * places to run contiguously from 1, so a structure paying 1, 2, 3 and 5 has a
 * length of 4 — a place that is not paid at all. That number was:
 *
 *   - handed to HandForHandBanner as `paidPositions`, so hand-for-hand would
 *     start at the wrong point;
 *   - printed by Rewards as the "Money Bubble" figure;
 *   - compared against each row's place to tag the bubble row, so on such a
 *     structure the tag rendered on the wrong row or on none.
 *
 * A length is exactly right for every contiguous structure, which is nearly
 * all of them. It is wrong precisely where it matters and nowhere else.
 */
export function lastPaidPlace(raw: unknown): number {
  const places = parsePayoutStructure(raw);
  if (!places || places.length === 0) return 0;
  // Sorted ascending by parsePayoutStructure, so the tail is the deepest place.
  return places[places.length - 1].place;
}

/**
 * What one place is paid.
 *
 * 2026-08-29: this used to be `Math.trunc(pool * pct) / 100` and took a single
 * percentage, which is two bugs in one line.
 *
 * It TRUNCATED where the engine rounds, and it had no way to express the
 * residual rule -- the last paid place takes what is left, so the places sum
 * to the pool -- because a function given one percentage cannot know what the
 * other places took. Measured across the pool and structure combinations
 * actually used in production: 13 of 78 showed the player a different number
 * from the one that reached their wallet.
 *
 * The old comment claimed it matched "the money" via
 * TournamentService.calculatePayout. That function has no callers and is
 * itself a dead client duplicate; the money is the engine, and the engine's
 * rule now lives in src/lib/payoutMath.ts, byte-identical to the server's.
 *
 * A player must never be shown one number and paid another.
 *
 * THE UNIT IS STATED, NOT INHERITED (2026-09-13). `computePlacePrize` gained a
 * `unitCents` parameter that defaulted to a cent, and every display in this
 * app - the lobby panel, the info panel, Rewards, Detail Overview and the
 * tournament page - omitted it. A default is not a decision, and CLAUDE.md
 * 10.86 rule 1 is about exactly this: a signal that answers confidently when it
 * cannot tell. The parameter is required now and this wrapper names its answer.
 *
 * It is the chip unit because this is a projection drawn from a tournament row
 * and a payout structure; none of the five callers has read the club's asset,
 * and every tournament that can currently exist is a chip tournament. When
 * Diamond tournaments open, this wrapper takes the unit from its callers -
 * `UNIT_CENTS_ASSET_NOT_READ` is what finds them.
 */
export function placePrize(
  pool: number,
  structure: Array<{ place?: number; percentage?: number }>,
  place: number
): number {
  return computePlacePrize(Number(pool), structure, Number(place), UNIT_CENTS_ASSET_NOT_READ);
}

/**
 * The advertised prize pool: the collected pool, floored by the guarantee.
 *
 * Detail's podium used the raw `prize_pool` while Rewards used this, so on any
 * guaranteed event with an overlay the two tabs printed different money for
 * first place. One rule, one number (2026-08-26 audit).
 */
export function effectivePrizePool(
  poolValue: number | null | undefined,
  guaranteeValue: number | null | undefined
): number {
  const pool = finite(poolValue);
  const guarantee = finite(guaranteeValue);
  return guarantee > 0 ? Math.max(pool, guarantee) : pool;
}

/**
 * The advertised pool remains the tournament prize pool; this is the portion
 * its place percentages divide after the optional stone-bubble buy-in has
 * been reserved. Satellite residuals belong to their seat-award authority.
 */
export function effectivePlaceLadderPool(
  poolValue: number | null | undefined,
  guaranteeValue: number | null | undefined,
  structureValue: unknown,
  fieldSize: number,
  bubbleProtection: boolean,
  buyInAmount: number,
  isSatellite: boolean
): number | null {
  const pool = effectivePrizePool(poolValue, guaranteeValue);
  const structure = parsePayoutStructure(structureValue) ?? [];
  return prizePoolAvailableToPlaces(
    pool,
    structure,
    fieldSize,
    bubbleProtection && !isSatellite,
    buyInAmount
  );
}

/** Two initials for an avatar that has no image. */
export function initials(name: string | null | undefined): string {
  const clean = (name || '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
