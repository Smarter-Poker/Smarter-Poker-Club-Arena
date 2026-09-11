/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVERYONE HEARS IT: THE JACKPOT ANNOUNCES ITSELF FROM ITS OWN LEDGER ROW
 *  BBJ build plan phase 3.1 (docs/BBJ-BUILD-PLAN.md), 2026-09-06
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS REPLACES, and why inferring a hit from a counter was wrong.
 *
 * The client used to learn about a jackpot by watching `bbj_pools.hit_count`
 * over Realtime and noticing it go up. Everything about that was indirect:
 *
 *   - `payload.old` carries ONLY the primary key (default replica identity),
 *     so the "previous" count was ALWAYS 0 and the real gate was a module
 *     variable that reset on every page load. Dan reported the consequence
 *     twice: "this old bad beat jackpot comes up every single time you log in,
 *     and it's the same one."
 *   - The row it watched updates on every raked hand - 40,219 times in
 *     twenty-four hours, measured 2026-09-06 - to carry a signal that fires
 *     roughly once a fortnight.
 *   - Having noticed the counter move, it still had to go and ASK who won,
 *     with a retry, because the counter says nothing about the hit. When that
 *     lookup failed it emitted a fallback with `tableId: ''` - which the only
 *     subscriber drops on its first line. The fallback was dead code.
 *
 * `bbj_winners` gets exactly one row per jackpot, written by
 * `bbj_atomic_payout_v2` INSIDE the same transaction as the debit and the
 * credits. So the row exists if and only if a jackpot was actually paid, it
 * carries who won and how much, and it arrives once. One INSERT a fortnight
 * replaces 40,219 UPDATEs a day, and the announcement stops being an
 * inference.
 *
 * NAMES ARE STILL READ FROM THE LEDGER FUNCTION, NOT THE ROW. Measured on
 * production for hand #1007239: `fn_bbj_recent_hits` names the bad-beat holder
 * `buf_pam` while `bbj_winners.winner_display_name` on the same row says
 * `AlaskaAlex`. The function returns the ARENA name (the name the rest of the
 * platform shows); the column holds whatever was current when the row was
 * written. So the feed enriches from the function and uses the row only when
 * that fails - and the row's own fields are a real fallback, unlike the empty
 * one they replace.
 *
 * WHICH SIDE IS "THE WINNER". Verified against the same hand rather than
 * assumed, because the column names read backwards: `bbj_winners.winner_*` is
 * the BAD BEAT HOLDER - four of a kind, 892.44, the 50% share - and matches
 * `fn_bbj_recent_hits.bad_beat_*`. `loser_*` is the player who won the pot and
 * takes 25%. The card says "X Won $Y", and X is the bad-beat holder.
 *
 * THIS IS A SECOND PRODUCER, DELIBERATELY. A player sitting at a table of the
 * club still hears it first through the engine socket (`bbj_hit_global`), which
 * is faster than any database round trip. Both emit; `shouldAnnounceBbjHit`
 * de-duplicates on the hit's own identity, so the belt and the braces cost one
 * suppressed event and cover each other when either path is down.
 */

import { supabase } from './supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import { refreshBbjMini } from './bbjMiniFeed';

/** The shape of the row Realtime hands us. Every field is optional on the wire. */
interface BbjWinnerRow {
  pool_id?: string;
  table_id?: string;
  hand_number?: number | string;
  winner_display_name?: string;
  winner_payout?: number | string;
  total_payout?: number | string;
  awarded_at?: string;
  /**
   * Which jackpot paid it (BBJ phase 6, 2026-09-07). Absent on every row
   * written before the mini existed, which is why it defaults to main.
   */
  kind?: string | null;
}

interface PoolWatch {
  count: number;
  channel: ReturnType<typeof supabase.channel> | null;
}

const watches = new Map<string, PoolWatch>();

/**
 * The award row and the ledger row are written by the same transaction, but a
 * READER can still arrive between the commit and the function's own view of
 * it under replica lag. One retry after a beat, exactly as the path this
 * replaces did, and then the row's own fields.
 */
const ENRICH_RETRY_MS = 300;

async function enrich(poolId: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, error } = await supabase.rpc('fn_bbj_recent_hits', {
      p_pool_id: poolId,
      p_limit: 1,
    });
    if (error) {
      reportError(error, 'bbjHitFeed.enrich_failed', { poolId, attempt });
      return null;
    }
    const row = Array.isArray(data) ? data[0] : null;
    if (row) return row as Record<string, unknown>;
    if (attempt === 1) await new Promise((r) => setTimeout(r, ENRICH_RETRY_MS));
  }
  return null;
}

async function announce(row: BbjWinnerRow, poolId: string): Promise<void> {
  /* THE MINI DOES NOT TAKE OVER EVERY SCREEN ON THE PLATFORM (BBJ phase 6).
     This feed drives BBJ_HIT_GLOBAL, and BBJHitAnnouncer turns that into a
     full announcement on every page every player has open - which is right for
     a jackpot that fires about once a fortnight and is measured in six figures.
     A mini fires ABOUT FOUR TIMES A DAY for a few hundred chips. Announcing it
     the same way would put a takeover on every screen every six hours, and an
     alarm that is always on is an alarm that gets muted (CLAUDE.md 10.84) -
     except here what gets muted is the real jackpot.

     A mini is not hidden: it gets the full celebration AT ITS OWN TABLE from
     the engine's `bbj_hit` event, it appears in the ticker, and it is listed
     and badged on the Previous Winners page. It just does not interrupt
     everybody else.

     A row with no `kind` is a main jackpot - every row written before today. */
  if ((row.kind || 'main') !== 'main') {
    /* A mini just left the reserve: every surface showing "what the mini pays
       here" re-reads now rather than in up to a minute (lib/bbjMiniFeed). */
    refreshBbjMini();
    return;
  }

  /* THE HIT IS REAL BEFORE ANY OF THIS RUNS. The row only exists because the
     payout transaction committed, so nothing below may decide not to announce
     - it can only decide how much it knows. A jackpot nobody saw is the
     feature not existing. */
  const handNumber = Number(row.hand_number) || 0;
  const awardedAt = row.awarded_at ? new Date(row.awarded_at).getTime() : Date.now();

  let tableId = row.table_id || '';
  let tableName = '';
  let winnerName = row.winner_display_name || '';
  let amount = Number(row.winner_payout);
  let gameVariant = 'Poker';
  let bigBlind = 0;

  try {
    const hit = await enrich(poolId);
    if (hit) {
      if (hit.table_id) tableId = String(hit.table_id);
      if (hit.table_name) tableName = String(hit.table_name);
      if (hit.bad_beat_name) winnerName = String(hit.bad_beat_name);
      const enrichedAmount = Number(hit.bad_beat_amount);
      if (Number.isFinite(enrichedAmount) && enrichedAmount > 0) amount = enrichedAmount;
      if (hit.game_variant) gameVariant = String(hit.game_variant);
      const bb = Number(hit.big_blind);
      if (Number.isFinite(bb)) bigBlind = bb;
    }
  } catch (e) {
    reportError(e, 'bbjHitFeed.enrich_threw', { poolId, handNumber });
  }

  if (!tableName && tableId) {
    try {
      const { data, error } = await supabase
        .from('tables')
        .select('name')
        .eq('id', tableId)
        .maybeSingle();
      /* The card falls back to "a table", so this never stops the
         announcement - but a read that fails silently is how a surface goes
         quietly wrong for months, so it leaves a trace. */
      if (error) reportError(error, 'bbjHitFeed.table_name_read_failed', { tableId });
      if (data?.name) tableName = String(data.name);
    } catch (e) {
      reportError(e, 'bbjHitFeed.table_name_read_threw', { tableId });
    }
  }

  if (!Number.isFinite(amount) || amount <= 0) amount = Number(row.total_payout) || 0;

  /* The announcer refuses a payload with no tableId on its first line, which
     is what made the old fallback dead code. If the hit genuinely cannot name
     its table, say so rather than emitting something guaranteed to be
     dropped. */
  if (!tableId) {
    reportError(
      new Error(`[BBJ] a jackpot was paid on pool ${poolId} hand #${handNumber} with no table id`),
      'bbjHitFeed.hit_without_table'
    );
    return;
  }

  masterBus.emit('BBJ_HIT_GLOBAL', {
    tableId,
    tableName: tableName || 'a table',
    gameVariant,
    bigBlind,
    winnerName: winnerName || 'A player',
    amount,
    handNumber,
    emittedAt: awardedAt,
  });
}

/**
 * Hear every jackpot paid out of one pool. Returns the unsubscribe.
 *
 * Scoped by POOL rather than by club on purpose: a union banks one jackpot for
 * all of its clubs, so a player in a union hears a hit at any of its tables -
 * which is the whole point of a union-wide jackpot, and what a club_id filter
 * would silently take away.
 *
 * Ref-counted, so the lobby, the ticker and a table open at once share ONE
 * channel rather than three.
 */
export function watchBbjHits(poolId: string): () => void {
  if (!poolId) return () => undefined;

  let watch = watches.get(poolId);
  if (!watch) {
    watch = { count: 0, channel: null };
    watches.set(poolId, watch);
  }
  const owned = watch;
  owned.count += 1;

  if (!owned.channel) {
    owned.channel = supabase
      .channel(`bbj-hits-${poolId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'bbj_winners', filter: `pool_id=eq.${poolId}` },
        (payload) => {
          const row = payload.new as BbjWinnerRow | undefined;
          if (!row) return;
          void announce(row, poolId);
        }
      )
      .subscribe();
  }

  return () => {
    owned.count -= 1;
    if (owned.count > 0) return;
    if (owned.channel) supabase.removeChannel(owned.channel);
    watches.delete(poolId);
  };
}

/** Test-only. Never called by the app. */
export function __resetBbjHitFeedForTests(): void {
  for (const w of watches.values()) if (w.channel) supabase.removeChannel(w.channel);
  watches.clear();
}
