/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * RAKEBACK SETTLER SERVICE — Periodic Per-Player Rake Aggregator (Daemon)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * BUG ORIGIN (2026-04-15 live verification):
 *   The in-memory rake accumulator inside RakebackEngine.recordHandRake is never
 *   flushed because settleRakeback() has zero callers. Result: rakeback_periods
 *   table is empty (0 rows in 7 days) even though rake_history has 6,869 hands
 *   recorded ($30,136.94 in rake). Players never see accumulated rakeback in UI;
 *   weekly settlement flow has no rows to settle. If the engine restarts, the
 *   in-memory accumulator is lost.
 *
 * FIX:
 *   This daemon runs every 30 minutes. For each completed hand in rake_records
 *   that hasn't been settled yet, it derives the equal-share per-player rake
 *   credit (FIX 144) and upserts rakeback_periods rows by (user_id, club_id,
 *   period_start_week). Idempotent: re-running over already-settled hands has
 *   no effect.
 *
 * SAFETY:
 *   - Reads only from rake_records (durable per-hand audit log)
 *   - Writes only to rakeback_periods (no chip movement)
 *   - Idempotent via period-week bucketing + ON CONFLICT update
 *   - 30-minute interval; can be tuned per traffic
 *
 * RELATED:
 *   - DECISION D-001: rake is EQUAL SHARE, never weighted (FIX 144)
 *   - .memory/problems/008-rakeback-settler-missing.md
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

const SETTLEMENT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const DAEMON_KEY = 'rakeback_settler';

/**
 * Rows pulled from rake_records per batch. Exported so the M6 regression suite
 * can build a dataset that genuinely straddles the LIMIT boundary rather than
 * hard-coding a number that could drift away from the real one.
 */
export const FETCH_LIMIT = 10000;

/**
 * AUDIT M6: how many FULL batches one cycle will drain before deferring the
 * rest to the next interval.
 *
 * Before this existed, a cycle read at most FETCH_LIMIT rows and then slept 30
 * minutes regardless of how much backlog remained, so recovering from a long
 * outage took one interval per 10,000 records. The cap is deliberately small
 * rather than unbounded: a full batch runs thousands of SEQUENTIAL per-player
 * commission RPCs, so each one is expensive, and an unbounded drain would let a
 * single cycle run for hours while `isSettling` blocks every other cycle
 * behind it. Three batches recovers ~9 hours of downtime per cycle, which is
 * far more than the ~560 records a normal 30-minute cycle produces. When the
 * cap is hit we LOG it — a silently truncated drain reads exactly like a
 * finished one.
 */
export const MAX_DRAIN_BATCHES = 3;

/**
 * AUDIT M6 — the settler's resume position in rake_records.
 *
 * `createdAt` is kept as the RAW PostgREST string, never round-tripped through
 * `new Date()`. Postgres timestamps carry microseconds; `new Date(iso)`
 * truncates to milliseconds, so persisting a Date-derived value stored a
 * cursor that does not correspond to any real row.
 *
 * `id` is null only for a cursor written before this field existed (or when a
 * row somehow arrives without one). A null id means "no tie-break available",
 * and the reader degrades to the old timestamp-only filter for exactly one
 * cycle.
 */
interface RakeCursor {
  createdAt: string;
  id: string | null;
}

/**
 * Outcome of one batch, so the drain loop knows whether to go round again.
 *   'idle'   — fewer than FETCH_LIMIT rows: fully caught up, nothing to drain
 *   'more'   — exactly FETCH_LIMIT rows: the cursor advanced, call again
 *   'halted' — a read failed: the cursor did NOT advance, stop and retry later
 */
type CycleResult = 'idle' | 'more' | 'halted';

/**
 * PostgREST embeds filter values in a comma/parenthesis-delimited grammar, so a
 * value carrying a quote, comma or bracket would change the SHAPE of the
 * filter rather than its value. Both cursor components come from typed
 * Postgres columns (timestamptz, uuid) and cannot contain these characters —
 * this guard exists so that if that ever stops being true the settler falls
 * back to the safe timestamp-only read instead of issuing a malformed or
 * subtly-widened query.
 */
function isFilterSafe(value: string): boolean {
  return !/["',()]/.test(value);
}

/**
 * AUDIT M6 — the composite `(created_at, id)` keyset predicate.
 *
 * Values are DOUBLE-QUOTED: a timestamptz renders as `2026-08-06
 * 20:30:07.941+00`, and both `:` and `+` are meaningful inside a PostgREST
 * filter. Verified against the live REST endpoint before this shipped — the
 * quoted form returns 200, and a malformed filter returns 400, so a green
 * response is real evidence and not a silently ignored parameter.
 */
function keysetFilter(createdAt: string, id: string): string {
  return `created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt."${id}")`;
}

const RAKEBACK_TIERS = [
  { minRake: 0, rakebackPercent: 5, name: 'Bronze' },
  { minRake: 100, rakebackPercent: 10, name: 'Silver' },
  { minRake: 500, rakebackPercent: 15, name: 'Gold' },
  { minRake: 2000, rakebackPercent: 20, name: 'Platinum' },
  { minRake: 10000, rakebackPercent: 30, name: 'Diamond' },
];

/**
 * RAKE-AUDIT 2026-07-24: exact integer-cents equal split of a hand's rake.
 * Returns a per-user share map whose values sum EXACTLY to totalRake.
 * The previous per-site `Math.round(rake / N * 100) / 100` rounded each
 * player's share independently, so the credited sum drifted from the actual
 * rake by up to N × $0.005 per hand — a systematic leak across thousands of
 * hands that also trips the equal-share verification harness
 * (scripts/verification-harness/02-equal-share-rake.sql). Remainder cents go
 * to the earliest users in iteration order (deterministic per hand).
 */
function equalShareCents(totalRake: number, userIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  const n = userIds.length;
  if (n === 0) return map;
  const totalCents = Math.round(totalRake * 100);
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  for (const uid of userIds) {
    let cents = base;
    if (remainder > 0) {
      cents += 1;
      remainder -= 1;
    }
    map.set(uid, cents / 100);
  }
  return map;
}

function tierFor(rakeContributed: number): { rate: number; name: string } {
  let chosen = RAKEBACK_TIERS[0];
  for (const tier of RAKEBACK_TIERS) {
    if (rakeContributed >= tier.minRake) chosen = tier;
  }
  return { rate: chosen.rakebackPercent / 100, name: chosen.name };
}

/** Returns the Monday 00:00 UTC of the week containing `d`. */
function weekStart(d: Date): string {
  const day = d.getUTCDay(); // 0=Sun
  const offset = (day + 6) % 7; // days since Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  return monday.toISOString().slice(0, 10);
}

function weekEnd(d: Date): string {
  const day = d.getUTCDay();
  const offset = (day + 6) % 7;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset));
  const sunday = new Date(monday.getTime() + 6 * 86400 * 1000);
  return sunday.toISOString().slice(0, 10);
}

interface RakeRecordRow {
  id?: string;
  is_tournament?: boolean | null;
  hand_id: string;
  club_id: string;
  rake_amount: number;
  player_contributions: Record<string, number> | null;
  created_at: string;
}

export class RakebackSettlerService {
  private isRunning = false;
  // SWEEP #4 FIX (2026-07-23): re-entrancy guard. runSettlement() fires every 30 min
  // and once on startup with no "still running" check. A backlog run (up to 10,000
  // rake_records × sequential per-dealt-in-player credit RPCs — easily >30 min after
  // downtime or on a first HWM-less deploy scanning 7 days) overlapped the next tick,
  // which re-read from the same not-yet-advanced watermark and RE-CREDITED every
  // agent_commissions row (the live commission ledger) and re-incremented player_stats.
  // isSettling makes overlapping runs no-op.
  private isSettling = false;
  private intervalHandle: NodeJS.Timeout | null = null;
  // AUDIT M6: was `lastSettledAt: Date | null` — a timestamp alone is not a
  // unique position in rake_records, so it could not express "resume after
  // THIS row" when several rows share one created_at.
  private cursor: RakeCursor | null = null;

  start(): void {
    if (this.isRunning) {
      console.log('[RakebackSettler] Already running');
      return;
    }
    this.isRunning = true;
    console.log(`[RakebackSettler] Starting (interval: ${SETTLEMENT_INTERVAL_MS / 60000}m)`);
    // Run once immediately on startup, then every 30 min
    this.runSettlement().catch((e: any) =>
      reportError(
        new Error(e?.message || JSON.stringify(e) || String(e)),
        'RakebackSettler.startup_run'
      )
    );
    this.intervalHandle = setInterval(() => {
      this.runSettlement().catch((e: any) =>
        reportError(
          new Error(e?.message || JSON.stringify(e) || String(e)),
          'RakebackSettler.interval_run'
        )
      );
    }, SETTLEMENT_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.isRunning = false;
    console.log('[RakebackSettler] Stopped');
  }

  /**
   * Load the durable high-water-mark so a restart resumes exactly where the last
   * run stopped instead of re-scanning the 7-day fallback window (which would
   * re-increment player_stats for already-settled hands).
   */
  private async loadHighWaterMark(): Promise<{ ok: boolean; value: RakeCursor | null }> {
    // RAKE-AUDIT 2026-07-24: distinguish "no watermark row yet" (genuine first
    // run → 7-day fallback is correct) from "read FAILED" (transient DB error).
    // The old signature collapsed both to null, so a transient failure at
    // startup silently re-scanned 7 days and re-incremented the NON-idempotent
    // player_stats accumulators (agent_commissions are safe — the RPC dedupes
    // on (user_id, source_id, source_type)). On a failed read the caller now
    // ABORTS the cycle and retries next interval instead of double-crediting.
    //
    // AUDIT M6: the timestamp is returned as the RAW string the database sent.
    // The old code did `new Date(data.high_water_mark)`, which silently dropped
    // the microsecond component of every Postgres timestamp — the cursor then
    // pointed at an instant no row actually occupies.
    try {
      const { data, error } = await supabase
        .from('daemon_state')
        .select('high_water_mark, high_water_mark_id')
        .eq('daemon', DAEMON_KEY)
        .maybeSingle();
      if (error) return { ok: false, value: null };
      if (!data?.high_water_mark) return { ok: true, value: null };
      return {
        ok: true,
        value: {
          createdAt: String(data.high_water_mark),
          id: data.high_water_mark_id ? String(data.high_water_mark_id) : null,
        },
      };
    } catch {
      return { ok: false, value: null };
    }
  }

  /** Persist the cursor durably (survives engine restarts). */
  private async saveHighWaterMark(cursor: RakeCursor): Promise<void> {
    try {
      await supabase.from('daemon_state').upsert(
        {
          daemon: DAEMON_KEY,
          high_water_mark: cursor.createdAt,
          high_water_mark_id: cursor.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.saveHighWaterMark'
      );
    }
  }

  /** Thin wrapper around supabase.rpc returning {error} for cleaner control flow. */
  private async supabaseRpc(name: string, args: Record<string, unknown>) {
    try {
      const { error } = await supabase.rpc(name, args);
      return { error };
    } catch (e) {
      return { error: e };
    }
  }

  /**
   * Aggregates rake_records since the last settlement (or last 7 days on first
   * run) into per-player rakeback_periods rows. Idempotent.
   */
  async runSettlement(): Promise<void> {
    // SWEEP #4: skip if a previous run is still in flight (prevents the double-credit
    // described on the isSettling field). The guard wraps the whole run in try/finally
    // so the flag always clears even on a thrown error.
    if (this.isSettling) {
      console.warn('[RakebackSettler] settlement already in progress — skipping overlapping run');
      return;
    }
    this.isSettling = true;
    try {
      // AUDIT M6: drain the backlog instead of processing one batch and then
      // sleeping 30 minutes. `_runSettlementInner` advances the durable cursor
      // before returning 'more', so each pass through this loop starts strictly
      // after the last row of the previous one — an interruption anywhere in
      // the loop resumes correctly rather than replaying.
      for (let batch = 1; ; batch++) {
        const result = await this._runSettlementInner();
        if (result !== 'more') break;
        if (batch >= MAX_DRAIN_BATCHES) {
          console.warn(
            `[RakebackSettler] drain cap reached after ${batch} full batches ` +
              `(${batch * FETCH_LIMIT} records) — backlog REMAINS and will continue next cycle`
          );
          break;
        }
      }
      // RAKE-AUDIT 2026-07-24: weekly financial close now runs SERVER-SIDE.
      // Previously the weekly rakeback settlement + credit-invoice generation
      // lived only in the browser (FinancialCronService/SettlementCronService
      // setInterval), so they fired ONLY while an admin had a tab open.
      await this.runWeeklyFinancialClose();
      // SWEEP #6: post-tournament money-conservation sentinel. Scans every
      // tournament that reached COMPLETED since the last cycle and asserts the
      // invariants that the whole rake/payout audit is meant to guarantee, so a
      // future regression that mints chips, strands players, or wrongly rakes a
      // tournament hand is caught within one settler cycle instead of silently
      // corrupting the ledger. Never mutates game state — reportError only.
      await this.runTournamentSentinel();
    } finally {
      this.isSettling = false;
    }
  }

  /**
   * SWEEP #6 — Tournament invariant sentinel.
   *
   * For each tournament newly observed as COMPLETED (watermarked by updated_at in
   * daemon_state under 'tournament_sentinel'), verify:
   *
   *   (1) PAYOUT CONSERVATION — for non-satellite events, the sum of paid
   *       tournament_players.prize must equal tournaments.prize_pool within a small
   *       rounding tolerance. A shortfall means chips were destroyed (players not
   *       paid); an overage means chips were minted. Satellite events pay tickets,
   *       not the cash pool, so they are exempt from this check.
   *
   *   (2) NO STRANDED PLAYERS — a COMPLETED tournament must have zero rows still in
   *       'playing'/'registered'/'active'. A stranded row is a lost seat/refund and
   *       the exact class of regression the sweep-4/5 cleanup helpers fixed.
   *
   *   (3) NO RAKED TOURNAMENT HANDS — the pot engine must take zero rake during
   *       tournament play (the only tournament money is the 10% entry fee, which is
   *       logged with hand_id NULL). Any rake_records row for this tournament with a
   *       hand_id AND positive rake_amount means the tournament rake-config gate
   *       regressed.
   *
   * Idempotent and cheap: bounded batch per cycle, advances the watermark to the
   * newest processed updated_at so each tournament is checked once.
   */
  private async runTournamentSentinel(): Promise<void> {
    const SENTINEL_KEY = 'tournament_sentinel';
    const BATCH = 100;
    try {
      const { data: state, error: stateErr } = await supabase
        .from('daemon_state')
        .select('high_water_mark')
        .eq('daemon', SENTINEL_KEY)
        .maybeSingle();
      if (stateErr) {
        console.warn('[TournamentSentinel] watermark read failed — skipping cycle');
        return;
      }
      // Epoch fallback on genuine first run so we don't rescan all history at once;
      // start from 24h ago to catch anything that completed around first boot.
      const sinceIso = state?.high_water_mark
        ? new Date(state.high_water_mark).toISOString()
        : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: tourneys, error: tErr } = await supabase
        .from('tournaments')
        .select('id, name, prize_pool, variant, satellite_target_id, updated_at')
        .eq('status', 'COMPLETED')
        .gt('updated_at', sinceIso)
        .order('updated_at', { ascending: true })
        .limit(BATCH);
      if (tErr) {
        console.warn(`[TournamentSentinel] tournament read failed: ${tErr.message}`);
        return;
      }
      if (!tourneys || tourneys.length === 0) return;

      let newWatermark = sinceIso;
      let violations = 0;

      for (const t of tourneys as Array<{
        id: string;
        name: string | null;
        prize_pool: number | null;
        variant: string | null;
        satellite_target_id: string | null;
        updated_at: string;
      }>) {
        if (t.updated_at > newWatermark) newWatermark = t.updated_at;
        // Pool-equality is only meaningful for events where the ENTIRE cash pool
        // flows through tournament_players.prize. It does NOT hold for:
        //   • satellites — they pay tickets/seats, not the cash pool;
        //   • bounty / PKO / mystery — the bounty slice is paid to knockers through
        //     a separate bounty ledger, so tp.prize only holds the non-bounty pool.
        // These are exempt from check (1) but still checked for stranded players and
        // raked hands.
        const variant = (t.variant ?? '').toLowerCase();
        const skipPoolCheck =
          variant === 'satellite' ||
          !!t.satellite_target_id ||
          variant === 'bounty' ||
          variant === 'pko' ||
          variant === 'progressive_ko' ||
          variant === 'mystery' ||
          variant === 'mystery_bounty';

        // (1) Payout conservation (full-cash-pool events only).
        if (!skipPoolCheck) {
          const { data: prizeRows, error: pErr } = await supabase
            .from('tournament_players')
            .select('prize')
            .eq('tournament_id', t.id)
            .gt('prize', 0);
          if (!pErr) {
            const paid = (prizeRows ?? []).reduce(
              (s, r) => s + (Number((r as { prize: number | null }).prize) || 0),
              0
            );
            const pool = Number(t.prize_pool) || 0;
            // Tolerance: 1 currency unit or 1% of pool, whichever is larger, to
            // absorb legitimate per-position rounding without masking real leaks.
            const tolerance = Math.max(1, pool * 0.01);
            if (pool > 0 && Math.abs(paid - pool) > tolerance) {
              violations++;
              reportError(
                new Error(
                  `Tournament payout conservation breach: tournament ${t.id} (${t.name ?? 'unnamed'}) ` +
                    `paid ${paid.toFixed(2)} vs prize_pool ${pool.toFixed(2)} (diff ${(paid - pool).toFixed(2)}, tol ${tolerance.toFixed(2)})`
                ),
                'TournamentSentinel.payout_conservation',
                { tournamentId: t.id, paid, pool }
              );
            }
          }
        }

        // (2) No stranded players.
        {
          const { count, error: sErr } = await supabase
            .from('tournament_players')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .in('status', ['playing', 'registered', 'active']);
          if (!sErr && (count ?? 0) > 0) {
            violations++;
            reportError(
              new Error(
                `Stranded players on COMPLETED tournament ${t.id} (${t.name ?? 'unnamed'}): ${count} row(s) still active`
              ),
              'TournamentSentinel.stranded_players',
              { tournamentId: t.id, stranded: count }
            );
          }
        }

        // (3) No raked tournament hands.
        {
          const { count, error: rErr } = await supabase
            .from('rake_records')
            .select('id', { count: 'exact', head: true })
            .eq('tournament_id', t.id)
            .not('hand_id', 'is', null)
            .gt('rake_amount', 0);
          if (!rErr && (count ?? 0) > 0) {
            violations++;
            reportError(
              new Error(
                `Raked tournament hands detected for tournament ${t.id} (${t.name ?? 'unnamed'}): ${count} hand(s) with positive rake`
              ),
              'TournamentSentinel.raked_tournament_hands',
              { tournamentId: t.id, rakedHands: count }
            );
          }
        }
      }

      // Advance watermark so processed tournaments are not re-scanned. Only writes
      // forward — a same-timestamp batch boundary is handled by the strict `>` read
      // filter (worst case a tournament is re-checked once, which is harmless).
      await supabase.from('daemon_state').upsert(
        {
          daemon: SENTINEL_KEY,
          high_water_mark: newWatermark,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
      console.log(
        `[TournamentSentinel] checked ${tourneys.length} completed tournament(s), ${violations} violation(s), watermark → ${newWatermark}`
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'TournamentSentinel.cycle'
      );
    }
  }

  /**
   * RAKE-AUDIT 2026-07-24: Server-authoritative weekly financial close.
   * Once per ISO week (first settler cycle on/after Monday 00:00 UTC):
   *   1. settle_club_rakeback for every club with pending LAPSED rakeback
   *      periods (the RPC pays each player's rakeback into their wallet and
   *      marks the period paid; a guard in the RPC skips still-open weeks).
   *   2. fn_generate_all_credit_invoices — weekly agent credit invoices.
   *   3. Reset agents.weekly_rake_generated for the new week (the commission
   *      RPC accumulates it; nothing ever reset it, so "weekly" grew forever).
   * Idempotent via a daemon_state watermark keyed to the week's Monday date —
   * every step is also individually idempotent (paid periods are skipped,
   * invoices dedupe), so a crash mid-close is safe to re-run.
   */
  private async runWeeklyFinancialClose(): Promise<void> {
    const WEEKLY_KEY = 'weekly_financial_close';
    try {
      const currentWeekStart = weekStart(new Date()); // Monday YYYY-MM-DD (UTC)
      const { data: state, error: stateErr } = await supabase
        .from('daemon_state')
        .select('high_water_mark')
        .eq('daemon', WEEKLY_KEY)
        .maybeSingle();
      if (stateErr) {
        console.warn('[RakebackSettler] weekly-close state read failed — will retry next cycle');
        return;
      }
      const lastClosedWeek = state?.high_water_mark
        ? new Date(state.high_water_mark).toISOString().slice(0, 10)
        : null;
      if (lastClosedWeek && lastClosedWeek >= currentWeekStart) return; // already closed this week

      console.log(
        `[RakebackSettler] Weekly financial close starting (week of ${currentWeekStart})`
      );

      // 1. Pay out lapsed rakeback periods per club
      const { data: pendingClubs } = await supabase
        .from('rakeback_periods')
        .select('club_id')
        .eq('status', 'pending')
        .lt('period_end', currentWeekStart)
        .limit(5000);
      const clubIds = [...new Set((pendingClubs ?? []).map((r) => r.club_id).filter(Boolean))];
      for (const clubId of clubIds) {
        const { error } = await this.supabaseRpc('settle_club_rakeback', { p_club_id: clubId });
        if (error) {
          reportError(
            new Error(`settle_club_rakeback failed for club ${clubId}: ${JSON.stringify(error)}`),
            'RakebackSettler.weekly_settle_club'
          );
        }
      }

      // 1.5 Union weekly 90/10 rakeback (Dan's spec, 2026-08-19): every member
      // club's rake is HELD in union_wallets.rake_wallet during the week; at
      // close, 90% is paid back to each club's chip_treasury and the union
      // keeps 10% (moves from the rake_wallet sub-account into general
      // chip_balance). The RPC is treasury-funded, service_role-only, and
      // idempotent via union_rakeback_log UNIQUE(union_id, period_start,
      // period_end) - safe to re-run on crash. Period = the just-lapsed ISO
      // week [previous Monday, this Monday).
      {
        const periodEnd = `${currentWeekStart}T00:00:00Z`;
        const prevMonday = new Date(`${currentWeekStart}T00:00:00Z`);
        prevMonday.setUTCDate(prevMonday.getUTCDate() - 7);
        const periodStart = prevMonday.toISOString();
        const { data: unions, error: unionsErr } = await supabase
          .from('unions')
          .select('id');
        if (unionsErr) {
          reportError(
            new Error(`union list read failed for weekly rakeback: ${unionsErr.message}`),
            'RakebackSettler.weekly_union_rakeback_list'
          );
        }
        for (const u of unions ?? []) {
          let result: unknown = null;
          let rpcError: unknown = null;
          try {
            const res = await supabase.rpc('fn_union_weekly_rakeback_close', {
              p_union_id: u.id,
              p_period_start: periodStart,
              p_period_end: periodEnd,
            });
            result = res.data;
            rpcError = res.error;
          } catch (e) {
            rpcError = e;
          }
          if (rpcError) {
            reportError(
              new Error(
                `fn_union_weekly_rakeback_close failed for union ${u.id}: ${JSON.stringify(rpcError)}`
              ),
              'RakebackSettler.weekly_union_rakeback'
            );
          } else {
            const r = (Array.isArray(result) ? result[0] : result) as
              | Record<string, unknown>
              | null;
            // already_executed is the idempotency guard, not a failure.
            if (r && r.success === false && r.error !== 'already_executed') {
              reportError(
                new Error(`union weekly rakeback rejected for ${u.id}: ${JSON.stringify(r)}`),
                'RakebackSettler.weekly_union_rakeback_rejected'
              );
            } else if (r && r.success === true) {
              console.log(
                `[RakebackSettler] Union weekly rakeback (${u.id}): paid ${String(
                  r.total_rakeback
                )} to ${String(r.clubs_paid)} clubs, retained ${String(r.union_retained)}`
              );
            }
          }
        }
      }

      // 2. Weekly agent credit invoices
      {
        const { error } = await this.supabaseRpc('fn_generate_all_credit_invoices', {});
        if (error) {
          reportError(
            new Error(`fn_generate_all_credit_invoices failed: ${JSON.stringify(error)}`),
            'RakebackSettler.weekly_invoices'
          );
        }
      }

      // 3. Reset weekly agent rake counters for the new week
      {
        const { error } = await supabase
          .from('agents')
          .update({ weekly_rake_generated: 0 })
          .gt('weekly_rake_generated', 0);
        if (error) {
          reportError(
            new Error(`weekly_rake_generated reset failed: ${error.message}`),
            'RakebackSettler.weekly_rake_reset'
          );
        }
      }

      // 4. Mark this week closed
      await supabase.from('daemon_state').upsert(
        {
          daemon: WEEKLY_KEY,
          high_water_mark: new Date(`${currentWeekStart}T00:00:00Z`).toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'daemon' }
      );
      console.log(
        `[RakebackSettler] Weekly financial close done: ${clubIds.length} clubs settled, invoices generated, weekly counters reset`
      );
    } catch (e) {
      reportError(
        new Error((e as { message?: string })?.message || String(e)),
        'RakebackSettler.weekly_close'
      );
    }
  }

  private async _runSettlementInner(): Promise<CycleResult> {
    // On first run after (re)start, resume from the durable cursor so we do not
    // re-scan already-settled rake_records (which double-counts player_stats).
    // Only fall back to the 7-day window on a genuine first run.
    if (this.cursor === null) {
      const hwm = await this.loadHighWaterMark();
      if (!hwm.ok) {
        // RAKE-AUDIT 2026-07-24: watermark read failed — do NOT fall back to a
        // 7-day rescan (double-credits player_stats). Retry next interval.
        console.warn('[RakebackSettler] high-water-mark read failed — skipping cycle');
        return 'halted';
      }
      this.cursor = hwm.value;
    }

    // ════════════════════════════════════════════════════════════════════════
    // AUDIT M6 — composite (created_at, id) keyset read.
    //
    // The original filter was `.gt('created_at', since).limit(10000)` with the
    // new watermark taken from the LAST row's created_at. Two rows sharing one
    // created_at that straddle the LIMIT boundary are then lost forever: row
    // 10000 sets the watermark to T and row 10001 (also at T) is excluded by
    // the strict `>` on every subsequent cycle. Production has 12 such
    // duplicate-timestamp groups today, so the collision is real.
    //
    // The direction of the danger is asymmetric and decides the design: every
    // downstream accumulator is idempotent (credit_agent_commission_from_rake
    // dedupes on (user_id, source_id, source_type), apply_rakeback_player_stats
    // claims through rakeback_stats_applied, rakeback_periods recomputes from
    // source), so RE-processing a row costs nothing while SKIPPING one loses a
    // player's money with no trace. Everything below therefore prefers the
    // wider read whenever it is unsure.
    //
    // `.gt(created_at)` is still the fallback when the cursor has no id — the
    // first cycle after this deploy, when high_water_mark_id is still NULL.
    // That path is byte-for-byte the old behaviour, so the deploy is a no-op
    // until the first cycle writes an id, and exact from the second onward.
    // ════════════════════════════════════════════════════════════════════════
    const sinceIso =
      this.cursor?.createdAt ?? new Date(Date.now() - 7 * 86400 * 1000).toISOString();
    const useKeyset =
      this.cursor?.id != null &&
      isFilterSafe(this.cursor.createdAt) &&
      isFilterSafe(this.cursor.id);
    const startedAt = Date.now();

    // 1. Pull rake_records STRICTLY AFTER the last processed record (exclusive
    // cursor => exactly-once processing) that have player_contributions.
    // RAKE-AUDIT 2026-07-24: id + is_tournament added — tournament/SNG fee rows
    // have no hand_id (they are not hands), so agent-commission crediting keys
    // idempotency on rake_records.id for those rows instead of skipping them.
    const base = supabase
      .from('rake_records')
      .select('id, is_tournament, hand_id, club_id, rake_amount, player_contributions, created_at');
    // ── 2026-08-17: the OR keyset predicate WAS the timeout ──
    //
    // `or=(created_at.gt."X",and(created_at.eq."X",id.gt."Y"))` is the textbook
    // composite keyset, and Postgres cannot use idx_rake_records_created_at_id
    // for it. It runs a full ordered index scan and applies the OR as a FILTER.
    // Measured against production:
    //
    //   OR keyset form   21,534 ms   Rows Removed by Filter: 560,302
    //   plain range         259 ms   same table, same LIMIT
    //
    // That is the [RakebackSettler.fetch_failed] "canceling statement due to
    // statement timeout" of 2026-08-17, and it explains why the failure looked
    // intermittent: the cold-start path (useKeyset false) already used the fast
    // form, so only cycles WITH a cursor died — the daemon that pays players
    // stalled precisely when it had made progress.
    //
    // Fix: ask for `created_at >= cursor` — sargable, index-friendly — then drop
    // the already-processed head of the page in memory (see the skip below).
    // Exactly-once is preserved: `gte` is a strict SUPERSET of the OR predicate
    // (it additionally returns the cursor row itself and any timestamp ties),
    // and the skip removes precisely that surplus. Ties on a timestamptz are
    // rare, so the overlap is a handful of rows per cycle.
    const filtered = useKeyset ? base.gte('created_at', sinceIso) : base.gt('created_at', sinceIso);
    const { data: rows, error: fetchErr } = await filtered
      .gt('rake_amount', 0)
      .not('player_contributions', 'is', null)
      // Both ORDER BY keys are required: the LIMIT boundary is only
      // deterministic if the sort is total, and a non-deterministic boundary
      // reintroduces the skip this fix exists to remove.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(FETCH_LIMIT);

    if (fetchErr) {
      reportError(
        new Error(fetchErr?.message || JSON.stringify(fetchErr) || String(fetchErr)),
        'RakebackSettler.fetch_failed'
      );
      return 'halted';
    }

    // Remove the surplus the `gte` widening introduced. On the keyset path the
    // page can begin with the cursor row itself plus any rows sharing its exact
    // timestamp that were already settled. Dropping them restores the old OR
    // predicate's semantics EXACTLY — strictly after (created_at, id) — without
    // asking Postgres for a filter it cannot index. Rows arrive ordered by
    // (created_at, id) ascending, so the already-seen entries are always a
    // contiguous prefix.
    // Page size AS POSTGRES RETURNED IT, captured before the skip below.
    //
    // `hitLimit` (further down) decides 'more' vs 'idle', i.e. whether the
    // drain loop goes round again. It must be judged on the RAW page: if the
    // skip removes even one row, a genuinely full 10,000-row page reads as
    // 9,999 and the settler concludes it is caught up while backlog remains.
    // The AUDIT M6 drain test caught exactly that.
    const rawPageSize = rows?.length ?? 0;

    if (useKeyset && rows && rows.length > 0) {
      const cursorId = this.cursor!.id as string;
      const before = rows.length;
      let drop = 0;
      while (drop < rows.length) {
        const r = rows[drop] as { created_at: string; id: string };
        if (r.created_at === sinceIso && r.id <= cursorId) drop++;
        else break;
      }
      if (drop > 0) {
        rows.splice(0, drop);
        console.log(
          `[RakebackSettler] keyset: skipped ${drop} already-settled row(s) at the cursor timestamp (page was ${before})`
        );
      }
    }

    if (!rows || rows.length === 0) {
      console.log(`[RakebackSettler] No new rake_records since ${sinceIso}`);
      // Nothing processed — leave the cursor untouched so any late-arriving
      // record with an earlier timestamp is still picked up next run.
      return 'idle';
    }

    // The exact position of the last row we will have fully processed this
    // batch. Persisting THIS (not now(), and not a Date-truncated copy of it)
    // guarantees no record after it is skipped and none before it is lost.
    const lastRow = rows[rows.length - 1] as RakeRecordRow;
    const nextCursor: RakeCursor = {
      createdAt: lastRow.created_at,
      id: lastRow.id ?? null,
    };
    // A full batch means there is almost certainly more behind it.
    // rawPageSize, not rows.length — see the note where it is captured. The
    // keyset skip can shorten `rows`, and judging fullness on the shortened
    // array would end the drain one page early and leave backlog unsettled.
    const hitLimit = rawPageSize >= FETCH_LIMIT;

    // 2. Aggregate per (user_id, club_id, week)
    type Bucket = {
      user_id: string;
      club_id: string;
      period_start: string;
      period_end: string;
      rake_generated: number;
    };
    const buckets = new Map<string, Bucket>();

    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      const dealtIn = Object.entries(row.player_contributions).filter(([, amt]) => Number(amt) > 0);
      if (dealtIn.length === 0) continue;

      // FIX 144 EQUAL SHARE — each dealt-in player gets totalRake / N
      // RAKE-AUDIT 2026-07-24: exact integer-cents split (shares sum to rake)
      const shares = equalShareCents(
        Number(row.rake_amount),
        dealtIn.map(([uid]) => uid)
      );
      const created = new Date(row.created_at);
      const ws = weekStart(created);
      const we = weekEnd(created);

      for (const [userId] of dealtIn) {
        const equalShare = shares.get(userId) ?? 0;
        const key = `${userId}:${row.club_id}:${ws}`;
        const cur = buckets.get(key);
        if (cur) {
          cur.rake_generated = Math.round((cur.rake_generated + equalShare) * 100) / 100;
        } else {
          buckets.set(key, {
            user_id: userId,
            club_id: row.club_id,
            period_start: ws,
            period_end: we,
            rake_generated: equalShare,
          });
        }
      }
    }

    if (buckets.size === 0) {
      console.log(
        `[RakebackSettler] Processed ${rows.length} rake_records — no eligible player-credits`
      );
      this.cursor = nextCursor;
      await this.saveHighWaterMark(nextCursor);
      return hitLimit ? 'more' : 'idle';
    }

    // 2b. BUG 009 FIX — Agent commission credit (per-rake-record, not aggregated).
    // For each player credited above, look up their agent (if any) and credit the
    // commission via credit_agent_commission_from_rake RPC. The RPC handles the
    // commission_rate lookup, ROUND, audit insert, and accumulator updates atomically.
    let agentCreditsAttempted = 0;
    let agentCreditsFailed = 0;
    let agentCreditsSkippedNoHand = 0;
    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      // Round 73: skip pre-R38-backfill rake_records that have no hand_id —
      // they can't be linked back to a hand for audit, and the settler used
      // to reprocess them on every restart (the cursor was in-memory only),
      // emitting NULL-source-id agent_commission rows on every cycle. Skipping
      // is correct: any commission for these legacy rows was already created
      // before the bug surfaced; reprocessing only creates duplicates.
      const handId = (row as { hand_id?: string | null }).hand_id;
      // RAKE-AUDIT 2026-07-24: tournament/SNG fee rows legitimately have no
      // hand_id (they are fees, not hands). They now generate agent commission
      // too — idempotency keys on the rake_records row id instead. Only legacy
      // NULL-hand CASH rows (pre-R38) are still skipped, as before.
      const isTournamentFee = (row as { is_tournament?: boolean | null }).is_tournament === true;
      const sourceId = handId ?? (isTournamentFee ? ((row as { id?: string }).id ?? null) : null);
      const sourceType = handId ? 'rake_settlement' : 'tournament_fee';
      if (!sourceId) {
        agentCreditsSkippedNoHand++;
        continue;
      }
      const dealtIn = Object.entries(row.player_contributions).filter(([, amt]) => Number(amt) > 0);
      if (dealtIn.length === 0) continue;
      // RAKE-AUDIT 2026-07-24: exact integer-cents split (shares sum to rake)
      const shares = equalShareCents(
        Number(row.rake_amount),
        dealtIn.map(([uid]) => uid)
      );
      for (const [userId] of dealtIn) {
        agentCreditsAttempted++;
        const { error: rpcErr } = await this.supabaseRpc('credit_agent_commission_from_rake', {
          p_agent_user_id: userId,
          p_club_id: row.club_id,
          p_rake_credit: shares.get(userId) ?? 0,
          p_source_type: sourceType,
          // Round 43: link the commission audit row + club_wallet_transactions
          // commission_out audit row back to the originating hand for
          // ledger reconciliation. For hands, sourceId is hand_history.id
          // (Round 38 FK); for tournament fees it is the rake_records.id.
          p_source_id: sourceId,
          p_notes: `RakebackSettler ${sourceType} at ${row.created_at}`,
        });
        if (rpcErr) {
          agentCreditsFailed++;
        }
      }
    }
    if (agentCreditsAttempted > 0 || agentCreditsSkippedNoHand > 0) {
      console.log(
        `[RakebackSettler] Agent-commission credits: ${agentCreditsAttempted - agentCreditsFailed}/${agentCreditsAttempted} OK` +
          (agentCreditsSkippedNoHand > 0
            ? `, ${agentCreditsSkippedNoHand} skipped (no hand_id — pre-R38 legacy rows)`
            : '') +
          ' (RPC silently skips non-agent players)'
      );
    }

    // 2c. player_stats refresh — IDEMPOTENT per (rake_record, user).
    // RAKE-AUDIT 2026-07-24 [money-adjacent]: the old JS read-then-update
    // aggregate was NON-idempotent — a crash between the player_stats increment
    // and saveHighWaterMark() re-incremented every stat on the next cycle (the
    // watermark had not advanced). Now each (rake_record, user) is applied
    // exactly once via apply_rakeback_player_stats, which claims on
    // rakeback_stats_applied in the SAME transaction as the increment, so a
    // re-scan of already-processed rows can never double-count. (rakeback_periods
    // is recompute-from-source and agent commission dedupes, so this was the last
    // non-idempotent accumulator; the watermark no longer needs to be atomic
    // with the increment for correctness.)
    let psApplied = 0;
    let psFailures = 0;
    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      const rrId = (row as { id?: string }).id;
      if (!rrId) continue; // no durable id -> cannot key idempotency; skip (safe)
      const dealtIn = Object.entries(row.player_contributions).filter(([, a]) => Number(a) > 0);
      if (dealtIn.length === 0) continue;
      // RAKE-AUDIT 2026-07-24: exact integer-cents split (shares sum to rake)
      const psShares = equalShareCents(
        Number(row.rake_amount),
        dealtIn.map(([uid]) => uid)
      );
      for (const [userId] of dealtIn) {
        const { error } = await this.supabaseRpc('apply_rakeback_player_stats', {
          p_rake_record_id: rrId,
          p_user_id: userId,
          p_club_id: row.club_id,
          p_hands: 1,
          p_rake: psShares.get(userId) ?? 0,
        });
        if (error) {
          psFailures++;
        } else {
          psApplied++;
        }
      }
    }
    if (psApplied > 0 || psFailures > 0) {
      console.log(
        `[RakebackSettler] player_stats idempotent applies: ${psApplied} OK (failures: ${psFailures})`
      );
    }

    // 3. Upsert into rakeback_periods. Round 45 RE-RUN fix: recompute the
    // FULL period total from the actual canonical rake_records rather than
    // INCREMENTING the existing row's rake_generated. The old incremental
    // logic double-counted on every engine restart because the settler's
    // 7-day fallback window re-processed already-credited records.
    //
    // Verified live before fix: top user had rake_generated=$4002 vs actual
    // share-from-rake_records of $1048 (4× over-credited from ~7 restarts).
    //
    // The new logic SETs rake_generated to the period total derived from
    // rake_records, so re-running over the same window converges to the
    // correct value rather than diverging.
    let upserts = 0;
    let failures = 0;
    for (const bucket of buckets.values()) {
      // Existing row (mostly for status check — paid rows are immutable)
      const { data: existing } = await supabase
        .from('rakeback_periods')
        .select('id, status')
        .eq('user_id', bucket.user_id)
        .eq('club_id', bucket.club_id)
        .eq('period_start', bucket.period_start)
        .maybeSingle();

      // Recompute the canonical period total from rake_records.
      // We sum equal-shares for this (user, club) within the period window.
      const periodEndDate = new Date(bucket.period_end + 'T23:59:59.999Z');
      const periodStartDate = new Date(bucket.period_start + 'T00:00:00.000Z');
      const { data: periodRows } = await supabase
        .from('rake_records')
        .select('rake_amount, player_contributions')
        .eq('club_id', bucket.club_id)
        .gte('created_at', periodStartDate.toISOString())
        .lte('created_at', periodEndDate.toISOString())
        .gt('rake_amount', 0)
        .not('player_contributions', 'is', null)
        .limit(50000);

      let totalRake = 0;
      for (const r of (periodRows as RakeRecordRow[] | null) ?? []) {
        if (!r.player_contributions) continue;
        const dealt = Object.entries(r.player_contributions).filter(([, a]) => Number(a) > 0);
        if (dealt.length === 0) continue;
        if (dealt.some(([uid]) => uid === bucket.user_id)) {
          // RAKE-AUDIT 2026-07-24: exact integer-cents split (shares sum to rake)
          const rcShares = equalShareCents(
            Number(r.rake_amount),
            dealt.map(([uid]) => uid)
          );
          totalRake += rcShares.get(bucket.user_id) ?? 0;
        }
      }
      totalRake = Math.round(totalRake * 100) / 100;
      const tier = tierFor(totalRake);
      const rakebackEarned = Math.round(totalRake * tier.rate * 100) / 100;

      if (existing && existing.status === 'pending') {
        const { error } = await supabase
          .from('rakeback_periods')
          .update({
            rake_generated: totalRake,
            rakeback_rate: tier.rate,
            rakeback_earned: rakebackEarned,
            rakeback_amount: rakebackEarned,
            total_rake_paid: totalRake,
          })
          .eq('id', existing.id);
        if (error) {
          failures++;
          reportError(
            new Error(error?.message || JSON.stringify(error) || String(error)),
            'RakebackSettler.update_failed'
          );
        } else {
          upserts++;
        }
      } else if (!existing) {
        const { error } = await supabase.from('rakeback_periods').insert({
          user_id: bucket.user_id,
          club_id: bucket.club_id,
          period_start: bucket.period_start,
          period_end: bucket.period_end,
          rake_generated: totalRake,
          rakeback_rate: tier.rate,
          rakeback_earned: rakebackEarned,
          rakeback_amount: rakebackEarned,
          total_rake_paid: totalRake,
          status: 'pending',
        });
        if (error) {
          failures++;
          reportError(
            new Error(error?.message || JSON.stringify(error) || String(error)),
            'RakebackSettler.insert_failed'
          );
        } else {
          upserts++;
        }
      }
      // status != 'pending' → already paid out, do not modify
    }

    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[RakebackSettler] Settled ${upserts}/${buckets.size} period rows from ${rows.length} hand records in ${elapsedMs}ms (failures: ${failures})`
    );
    this.cursor = nextCursor;
    await this.saveHighWaterMark(nextCursor);
    return hitLimit ? 'more' : 'idle';
  }
}
