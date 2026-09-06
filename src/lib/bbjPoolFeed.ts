/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE SOURCE FOR THE JACKPOT FIGURE
 *  BBJ build plan phase 3.2 (docs/BBJ-BUILD-PLAN.md), 2026-09-06
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS REPLACES, and why it had to go.
 *
 * `bbj_pools` was in the Realtime publication, and SIX surfaces subscribed to
 * it: the felt, the lobby header, the ticker, the wallet widget, the union
 * dashboard and the jackpot page. Every raked hand contributes, so every raked
 * hand is an UPDATE on that row - measured on production 2026-09-06,
 * **40,219 updates in twenty-four hours**, one every 2.1 seconds, around the
 * clock.
 *
 * Each of those updates is decoded by the WAL reader, filtered per
 * subscriber, and pushed to every open tab. The stream was already measured a
 * minute behind at peak (ClubHomePage's own occupancy poll exists because of
 * it), so the surfaces were paying the whole cost of a firehose to display a
 * number that a player reads once every few minutes and that nothing depends
 * on being exact to the second.
 *
 * WHAT REPLACES IT. One poll of `fn_bbj_pool_for_club` per CLUB - not per
 * surface, not per tab-panel - every ten seconds, and only while the document
 * is visible. Six subscribers on one club now share one timer and one request.
 * A backgrounded tab costs nothing at all, which the subscription could never
 * say: Realtime pushes to a hidden tab exactly as hard as to a visible one.
 *
 * WHY POLLING IS NOT A DOWNGRADE HERE.
 *
 *   - The figure is a slowly-drifting total. Ten seconds of lag on a jackpot
 *     that grows by a few chips a hand is invisible to a player and always
 *     was: the old path's own stream ran a minute late under load.
 *   - The event that actually MATTERS - the jackpot being hit - does not come
 *     through this feed at all any more. It comes from the `bbj_winners`
 *     INSERT (phase 3.1, lib/bbjHitFeed), which is one row per hit rather
 *     than 40,219 rows a day, and which carries the winner, the amount and
 *     the hand rather than making the client infer a hit from a counter.
 *   - A poll answers "I could not tell" honestly. A dead subscription looks
 *     exactly like a jackpot that is not moving, which is how the old felt
 *     figure could sit frozen for an hour with nothing anywhere going red.
 *
 * REFUSES TO GUESS. A failed read leaves the last known figure in place and
 * reports; it never publishes 0, because a zeroed jackpot on the felt reads as
 * "there is no jackpot here" and that is a lie about money.
 */

import { supabase } from './supabase';
import { reportError } from '../utils/errorReporter';

/** What a subscriber is told. `poolId` is stable for the life of the club. */
export interface BbjPoolSnapshot {
  poolId: string | null;
  mainBalance: number;
}

export type BbjPoolListener = (snapshot: BbjPoolSnapshot) => void;

/**
 * Ten seconds, and the reasoning rather than the number.
 *
 * The pool moves on every raked hand (~2.1s apart across the estate), so any
 * interval at all shows a figure that is behind by design. Ten seconds keeps
 * the felt within about five hands of the truth while costing ONE request per
 * club per ten seconds against 40,219 pushed updates a day per subscriber.
 * Faster buys precision nobody can perceive; slower makes a hit's reset
 * visibly late on the surfaces that do not get the hit event.
 */
export const BBJ_POOL_POLL_MS = 10_000;

interface ClubFeed {
  listeners: Set<BbjPoolListener>;
  timer: ReturnType<typeof setInterval> | null;
  last: BbjPoolSnapshot;
  /** Guards against two reads in flight when a visibility change races the timer. */
  reading: boolean;
}

const feeds = new Map<string, ClubFeed>();

/** Visible, or a non-browser environment (tests, SSR) where nothing is hidden. */
function documentIsVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

async function readOnce(clubId: string, feed: ClubFeed): Promise<void> {
  if (feed.reading) return;
  feed.reading = true;
  try {
    const { data, error } = await supabase.rpc('fn_bbj_pool_for_club', { p_club_id: clubId });
    if (error) {
      /* The last known figure stays on screen. Publishing 0 here would tell
         every player at every table of this club that the jackpot is empty. */
      reportError(error, 'bbjPoolFeed.read_failed', { clubId });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return;
    const mainBalance = Number(row.main_balance);
    if (!Number.isFinite(mainBalance)) return;
    const next: BbjPoolSnapshot = {
      poolId: (row.pool_id as string) ?? feed.last.poolId,
      mainBalance,
    };
    if (next.poolId === feed.last.poolId && next.mainBalance === feed.last.mainBalance) return;
    feed.last = next;
    for (const listener of feed.listeners) {
      try {
        listener(next);
      } catch (e) {
        /* One surface throwing must not stop the other five being told. */
        reportError(e, 'bbjPoolFeed.listener_threw', { clubId });
      }
    }
  } catch (e) {
    reportError(e, 'bbjPoolFeed.read_threw', { clubId });
  } finally {
    feed.reading = false;
  }
}

function tick(clubId: string, feed: ClubFeed): void {
  if (!documentIsVisible()) return;
  void readOnce(clubId, feed);
}

/** One listener across every feed, so N clubs do not add N document listeners. */
let visibilityHooked = false;
function onVisible(): void {
  if (!documentIsVisible()) return;
  /* Coming back to the tab is the one moment a player is definitely looking,
     so it reads immediately rather than waiting out the rest of the interval. */
  for (const [clubId, feed] of feeds) void readOnce(clubId, feed);
}

function hookVisibility(): void {
  if (visibilityHooked || typeof document === 'undefined') return;
  document.addEventListener('visibilitychange', onVisible);
  visibilityHooked = true;
}

/**
 * Watch a club's jackpot figure. Returns the unsubscribe.
 *
 * The listener is called immediately with the last known figure when one
 * exists, so a surface mounting into an already-running feed paints straight
 * away instead of showing a zero for up to ten seconds.
 */
export function watchBbjPool(clubId: string, listener: BbjPoolListener): () => void {
  if (!clubId) return () => undefined;
  hookVisibility();

  let feed = feeds.get(clubId);
  if (!feed) {
    feed = {
      listeners: new Set(),
      timer: null,
      last: { poolId: null, mainBalance: 0 },
      reading: false,
    };
    feeds.set(clubId, feed);
  }
  const owned = feed;
  owned.listeners.add(listener);

  if (owned.last.poolId !== null) listener(owned.last);

  if (owned.timer === null) {
    void readOnce(clubId, owned);
    owned.timer = setInterval(() => tick(clubId, owned), BBJ_POOL_POLL_MS);
  }

  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size > 0) return;
    if (owned.timer !== null) clearInterval(owned.timer);
    /* The club's row is dropped with its last listener. Keeping it would mean
       a player who left the club an hour ago still has a timer running. */
    feeds.delete(clubId);
  };
}

/** Test-only. Never called by the app. */
export function __resetBbjPoolFeedForTests(): void {
  for (const feed of feeds.values()) if (feed.timer !== null) clearInterval(feed.timer);
  feeds.clear();
}
