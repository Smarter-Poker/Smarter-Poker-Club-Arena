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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE ALLOCATION RULE, READ FROM THE ALLOCATOR (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every raked hand's drop is split three ways, and `fn_bbj_allocate` reads the
 * split from ONE authority: `ca_bbj_policy`. Below the pivot a drop is 50%
 * main / 25% backup / 25% promo; at or above 100,000 in main it becomes
 * 25 / 25 / 50.
 *
 * That threshold was written down in four places - the policy table, both
 * halves of `RakeConfig.ts` as `BBJ_PIVOT_THRESHOLD`, and twice more as bare
 * literals inside the jackpot page's own banner - with nothing checking that
 * they agreed. The policy is a TABLE: one UPDATE moves the real threshold with
 * no migration and no failing test anywhere, and the page would keep counting
 * toward a number the bank had stopped using.
 *
 * It has not mattered yet because nothing has changed. Measured 2026-09-11 it
 * is about to: the largest pool reaches the banner's own trigger in about a
 * week and the pivot itself in about two.
 *
 * WHY IT IS CACHED FOR THE SESSION rather than polled. This is a rule, not a
 * figure. It has changed once since it was written, by hand, and the page that
 * reads it is open for minutes. One read per session is the correct cost; a
 * timer here would be the 40,219-updates-a-day mistake in miniature.
 *
 * WHY NULL IS A REAL ANSWER. "Could not read the rule" is not "the rule is
 * 100,000" (CLAUDE.md 10.86). A caller that gets null must show nothing rather
 * than a threshold it guessed - a banner counting to an invented number is
 * worse than no banner.
 */
export interface BbjAllocationPolicy {
  pivotThreshold: number;
  standardMain: number;
  standardBackup: number;
  standardPromo: number;
  pivotMain: number;
  pivotBackup: number;
  pivotPromo: number;
}

let policyCache: BbjAllocationPolicy | null = null;
let policyInFlight: Promise<BbjAllocationPolicy | null> | null = null;

const rate = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

export async function getBbjAllocationPolicy(): Promise<BbjAllocationPolicy | null> {
  if (policyCache) return policyCache;
  /* One flight, however many surfaces ask at once. Without this, a page that
     mounts three jackpot components makes three identical reads on load. */
  if (policyInFlight) return policyInFlight;

  policyInFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('fn_bbj_allocation_policy');
      if (error) {
        reportError(error, 'bbjPoolFeed.allocation_policy_failed');
        return null;
      }
      const row = (data ?? null) as Record<string, unknown> | null;
      if (!row) return null;

      const parsed: BbjAllocationPolicy = {
        pivotThreshold: rate(row.pivot_threshold),
        standardMain: rate(row.standard_main),
        standardBackup: rate(row.standard_backup),
        standardPromo: rate(row.standard_promo),
        pivotMain: rate(row.pivot_main),
        pivotBackup: rate(row.pivot_backup),
        pivotPromo: rate(row.pivot_promo),
      };
      /* A rule that arrived unreadable is not a rule. Publishing a NaN
         threshold would put "NaN% Of" on a money surface, and publishing a
         zero one would make every pool look past the pivot. */
      if (Object.values(parsed).some((v) => !Number.isFinite(v)) || parsed.pivotThreshold <= 0) {
        reportError(
          'allocation policy returned an unusable rule',
          'bbjPoolFeed.allocation_policy_unusable'
        );
        return null;
      }

      policyCache = parsed;
      return parsed;
    } catch (e) {
      reportError(e, 'bbjPoolFeed.allocation_policy_threw');
      return null;
    } finally {
      policyInFlight = null;
    }
  })();

  return policyInFlight;
}

/**
 * How close to the pivot a surface starts saying so: 80% of the threshold,
 * derived from whatever the threshold actually is.
 *
 * The jackpot page typed `>= 80000` beside a progress bar dividing by
 * `100000`, which is the same number twice with no way to keep them together.
 * An earlier audit already found these two out of step once - the alert fired
 * at 50k while the bar measured against 100k - and fixed it by typing a third
 * literal.
 */
export const BBJ_PIVOT_APPROACH_FRACTION = 0.8;

/** Test-only. Never called by the app. */
export function __resetBbjPoolFeedForTests(): void {
  for (const feed of feeds.values()) if (feed.timer !== null) clearInterval(feed.timer);
  feeds.clear();
  policyCache = null;
  policyInFlight = null;
}
