/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD SLIDE TELEMETRY — counted here, flushed rarely, never in the way
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-05: "ADD THIS TO THE ADMIN PANEL SOMEWHERE."
 *
 * The two questions worth answering about the corner peel are whether players
 * turn it on and, once on, whether they finish the gesture or give up half
 * way. The commit threshold was chosen by feel; the ABANDON RATE is the only
 * thing that can say whether the feel was right.
 *
 * WHY COUNTERS AND NOT EVENTS. A peel happens on most hands. An event row per
 * peel would out-write hand_history for a number that is only ever read as a
 * ratio. So this counts in memory and flushes a batch into a daily per-user
 * rollup (fn_record_card_slide_usage) at most once a minute.
 *
 * THE RULES THIS FILE OBEYS:
 *   - it NEVER blocks or delays the gesture. Every call is fire-and-forget and
 *     every failure is swallowed: a metric that can break a poker table is a
 *     defect, not a metric.
 *   - it flushes on pagehide/visibilitychange, because the interesting session
 *     is the one that ends by closing the tab.
 *   - counters are ADDITIVE server-side, so a retry double-counts at worst.
 *     That is the right failure for a product signal; losing the day is not.
 */
import { supabase } from '../lib/supabase';

type Counter = 'started' | 'committed' | 'abandoned' | 'keyboard';

const EMPTY = { started: 0, committed: 0, abandoned: 0, keyboard: 0 };
let pending = { ...EMPTY };
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

/** At most one write a minute per tab, however hard the player is peeling. */
const FLUSH_INTERVAL_MS = 60_000;

function hasPending(): boolean {
  return pending.started + pending.committed + pending.abandoned + pending.keyboard > 0;
}

async function flush(): Promise<void> {
  if (!hasPending()) return;
  const batch = pending;
  pending = { ...EMPTY };
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await supabase.rpc('fn_record_card_slide_usage', {
      p_started: batch.started,
      p_committed: batch.committed,
      p_abandoned: batch.abandoned,
      p_keyboard: batch.keyboard,
    });
  } catch {
    /* A lost metric is a lost metric. It never becomes the player's problem. */
  }
}

function installListeners() {
  if (listenersInstalled || typeof document === 'undefined') return;
  listenersInstalled = true;
  // pagehide fires where beforeunload does not (bfcache, iOS Safari), and
  // visibilitychange catches a tab backgrounded and never returned to.
  const onLeave = () => {
    void flush();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
  });
  window.addEventListener('pagehide', onLeave);
}

function bump(counter: Counter) {
  pending[counter] += 1;
  installListeners();
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  }
}

export const cardSlideTelemetry = {
  /** A finger went down on a face-down hand and moved far enough to peel. */
  peelStarted: () => bump('started'),
  /** The peel passed the threshold and the hand opened. */
  peelCommitted: () => bump('committed'),
  /** The finger let go short of the threshold and the corner dropped back. */
  peelAbandoned: () => bump('abandoned'),
  /** The hand was opened from the keyboard instead of by peeling. */
  keyboardOpen: () => bump('keyboard'),
  /** Exposed for tests and for a deliberate flush at sign-out. */
  flushNow: flush,
  /** Test seam. */
  _peek: () => ({ ...pending }),
  _reset: () => {
    pending = { ...EMPTY };
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  },
};
