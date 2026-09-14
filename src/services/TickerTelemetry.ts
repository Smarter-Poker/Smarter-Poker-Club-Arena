/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TICKER TELEMETRY — counted here, flushed rarely, never in the way
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The live message rail carries eight sources, each with an operator switch,
 * and nothing has ever measured one of them. Every decision about what the bar
 * says has been taste, including mine: this programme reordered severities,
 * rewrote copy for a seated player and widened the last call for a major
 * without a single number saying whether any source is read at all.
 *
 * Three counters answer the question that matters:
 *
 *   shown      an announcement OWNED THE BAR, once per announcement per tab
 *   opened     the player pressed it and went to the event
 *   dismissed  the player closed it
 *
 * A source with impressions and no opens is spending the most valuable pixels
 * on this platform to say nothing. A source with a high dismiss rate is one
 * players are pushing away. Neither is visible today.
 *
 * THE RULES THIS FILE OBEYS, and they are the same rules CardSlideTelemetry
 * obeys because they are the right ones for a metric that lives on a felt:
 *
 *   - it NEVER blocks or delays the rail. Every call is fire-and-forget and
 *     every failure is swallowed: a metric that can break a poker table is a
 *     defect, not a metric.
 *   - ONCE PER ANNOUNCEMENT, not once per poll. The strip repaints constantly
 *     and the meaningful unit is "this player was told this thing", so an item
 *     id that has already been counted in this tab is never counted again.
 *   - it flushes on pagehide and on a hidden tab, because the interesting
 *     session is the one that ends by closing the tab.
 *   - counters are additive server-side, so a retry double-counts at worst.
 *     That is the right failure for a product signal; losing the day is not.
 */

import { supabase } from '../lib/supabase';
import type { TickerKind } from '../components/tournament/tickerMessages';

type Counter = 'shown' | 'opened' | 'dismissed';
type Batch = Partial<Record<TickerKind, Partial<Record<Counter, number>>>>;

/** At most one write a minute per tab, however busy the rail is. */
const FLUSH_INTERVAL_MS = 60_000;

/**
 * How many announcement ids we remember, so an impression is counted once.
 *
 * Bounded because a tab left open on a busy club overnight would otherwise
 * grow this without limit. Oldest out first; a re-counted impression after
 * hundreds of others is a rounding error, an unbounded set is a leak.
 */
const SEEN_LIMIT = 500;

let pending: Batch = {};
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;
const seen = new Set<string>();

function hasPending(): boolean {
  return Object.keys(pending).length > 0;
}

async function flush(): Promise<void> {
  if (!hasPending()) return;
  const batch = pending;
  pending = {};
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await supabase.rpc('fn_record_ticker_usage', { p_counts: batch });
  } catch {
    /* A lost metric is a lost metric. It never becomes the player's problem. */
  }
}

function installListeners(): void {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  const onLeave = () => {
    void flush();
  };
  // pagehide fires where beforeunload does not (bfcache, iOS Safari), and
  // visibilitychange catches a tab backgrounded and never returned to.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
  window.addEventListener('pagehide', onLeave);
}

function bump(kind: TickerKind, counter: Counter): void {
  const entry = pending[kind] || (pending[kind] = {});
  entry[counter] = (entry[counter] || 0) + 1;
  installListeners();
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  }
}

export const tickerTelemetry = {
  /**
   * An announcement owned the bar. Counted once per item per tab - the id is
   * stable across polls precisely so this can be.
   */
  shown(kind: TickerKind, itemId: string): void {
    if (!itemId || seen.has(itemId)) return;
    if (seen.size >= SEEN_LIMIT) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    seen.add(itemId);
    bump(kind, 'shown');
  },

  /** The player pressed the bar and went to the event. */
  opened(kind: TickerKind): void {
    bump(kind, 'opened');
  },

  /** The player closed it. */
  dismissed(kind: TickerKind): void {
    bump(kind, 'dismissed');
  },

  /** Test seam, and the pagehide path. */
  flushNow(): Promise<void> {
    return flush();
  },

  /** Test seam. */
  reset(): void {
    pending = {};
    seen.clear();
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  },
};

export default tickerTelemetry;
