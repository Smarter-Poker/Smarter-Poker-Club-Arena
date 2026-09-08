/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HAND HISTORY, LIVE — when the table's list refetches, and how a hand lands
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Phase 1 of the Previous Hand build plan (2026-09-05).
 *
 * Before this the table's Previous Hand list refetched on EVERY open (four
 * queries, a blink of the stats strip) and refreshed at no other time: a hand
 * that finished while the panel was open did not appear until the panel was
 * closed and reopened. The engine has emitted `hand_history_saved` with the
 * row's id since 2026-08-15; nothing on this surface listened to it.
 *
 * The rules, pure so they can be pinned:
 *
 *   - Fetch on the FIRST open for a table, on a failed fetch, and when the list
 *     is stale (no fetch in STALE_MS - a reconnect can miss an event). A reopen
 *     inside that window shows the list already built, instantly.
 *   - A saved hand is PREPENDED into play order, de-duplicated by id, and the
 *     list is capped at the page size the fetch uses.
 *
 * Nothing here is a cache of stale hands: the list is only ever what the
 * database returned plus what the engine has since announced, for THIS table.
 */

export const HAND_HISTORY_PAGE = 50;
import { publicOrigin } from './appBase';
/** A list older than this refetches on open, in case an event was missed. */
export const HAND_HISTORY_STALE_MS = 5 * 60_000;

export type HandHistoryLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface RefetchDecisionInput {
  state: HandHistoryLoadState;
  /** When the current list was fetched, or null if never. */
  fetchedAt: number | null;
  /** The table the current list was fetched for. */
  fetchedTableId: string | null;
  /** The table on screen. */
  tableId: string | null | undefined;
  now: number;
  staleMs?: number;
}

/** Whether opening the panel or the modal should hit the network. */
export function shouldRefetchHandHistory(input: RefetchDecisionInput): boolean {
  const staleMs = input.staleMs ?? HAND_HISTORY_STALE_MS;
  if (input.state === 'loading') return false;
  if (input.state !== 'ready') return true;
  if (input.fetchedAt === null) return true;
  if ((input.fetchedTableId ?? null) !== (input.tableId ?? null)) return true;
  return input.now - input.fetchedAt >= staleMs;
}

export interface HandLike {
  id: string;
  handNumber: number;
}

/**
 * The saved hand into the list, newest first, once. A hand the list already
 * holds (a recovered-queue re-emit, a duplicate event) replaces its copy.
 */
export function prependHand<T extends HandLike>(
  list: readonly T[],
  hand: T,
  cap: number = HAND_HISTORY_PAGE
): T[] {
  const without = list.filter((h) => h.id !== hand.id);
  const next = [hand, ...without];
  next.sort((a, b) => (b.handNumber || 0) - (a.handNumber || 0));
  return next.slice(0, cap);
}

/** The archive URL that opens on one hand (Phase 1 deep link). */
/** The router's basename (main.tsx `<BrowserRouter basename>`), not Vite's BASE_URL, which is '/' under test. */
const APP_BASE = '/hub/club-arena';

export function handDeepLink(handId: string, origin?: string): string {
  const base = APP_BASE;
  const o = origin ?? publicOrigin();
  return `${o}${base}/hand-history?hand=${encodeURIComponent(handId)}`;
}
