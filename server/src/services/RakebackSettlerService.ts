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
  private lastSettledAt: Date | null = null;

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
  private async loadHighWaterMark(): Promise<{ ok: boolean; value: Date | null }> {
    // RAKE-AUDIT 2026-07-24: distinguish "no watermark row yet" (genuine first
    // run → 7-day fallback is correct) from "read FAILED" (transient DB error).
    // The old signature collapsed both to null, so a transient failure at
    // startup silently re-scanned 7 days and re-incremented the NON-idempotent
    // player_stats accumulators (agent_commissions are safe — the RPC dedupes
    // on (user_id, source_id, source_type)). On a failed read the caller now
    // ABORTS the cycle and retries next interval instead of double-crediting.
    try {
      const { data, error } = await supabase
        .from('daemon_state')
        .select('high_water_mark')
        .eq('daemon', DAEMON_KEY)
        .maybeSingle();
      if (error) return { ok: false, value: null };
      return { ok: true, value: data?.high_water_mark ? new Date(data.high_water_mark) : null };
    } catch {
      return { ok: false, value: null };
    }
  }

  /** Persist the high-water-mark durably (survives engine restarts). */
  private async saveHighWaterMark(ts: Date): Promise<void> {
    try {
      await supabase
        .from('daemon_state')
        .upsert(
          {
            daemon: DAEMON_KEY,
            high_water_mark: ts.toISOString(),
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
      await this._runSettlementInner();
      // RAKE-AUDIT 2026-07-24: weekly financial close now runs SERVER-SIDE.
      // Previously the weekly rakeback settlement + credit-invoice generation
      // lived only in the browser (FinancialCronService/SettlementCronService
      // setInterval), so they fired ONLY while an admin had a tab open.
      await this.runWeeklyFinancialClose();
    } finally {
      this.isSettling = false;
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

      console.log(`[RakebackSettler] Weekly financial close starting (week of ${currentWeekStart})`);

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

  private async _runSettlementInner(): Promise<void> {
    // On first run after (re)start, resume from the durable high-water-mark so we
    // do not re-scan already-settled rake_records (which double-counts
    // player_stats). Only fall back to the 7-day window on a genuine first run.
    if (this.lastSettledAt === null) {
      const hwm = await this.loadHighWaterMark();
      if (!hwm.ok) {
        // RAKE-AUDIT 2026-07-24: watermark read failed — do NOT fall back to a
        // 7-day rescan (double-credits player_stats). Retry next interval.
        console.warn('[RakebackSettler] high-water-mark read failed — skipping cycle');
        return;
      }
      this.lastSettledAt = hwm.value;
    }
    const sinceIso = (this.lastSettledAt ?? new Date(Date.now() - 7 * 86400 * 1000)).toISOString();
    const startedAt = Date.now();

    // 1. Pull rake_records STRICTLY AFTER the last processed record (exclusive
    // watermark => exactly-once processing) that have player_contributions.
    // RAKE-AUDIT 2026-07-24: id + is_tournament added — tournament/SNG fee rows
    // have no hand_id (they are not hands), so agent-commission crediting keys
    // idempotency on rake_records.id for those rows instead of skipping them.
    const { data: rows, error: fetchErr } = await supabase
      .from('rake_records')
      .select('id, is_tournament, hand_id, club_id, rake_amount, player_contributions, created_at')
      .gt('created_at', sinceIso)
      .gt('rake_amount', 0)
      .not('player_contributions', 'is', null)
      .order('created_at', { ascending: true })
      .limit(10000);

    if (fetchErr) {
      reportError(
        new Error(fetchErr?.message || JSON.stringify(fetchErr) || String(fetchErr)),
        'RakebackSettler.fetch_failed'
      );
      return;
    }

    if (!rows || rows.length === 0) {
      console.log(`[RakebackSettler] No new rake_records since ${sinceIso}`);
      // Nothing processed — leave the watermark untouched so any late-arriving
      // record with an earlier timestamp is still picked up next run.
      return;
    }

    // Highest timestamp we will have fully processed this run. Persisting THIS
    // (not now()) guarantees no record created after it is skipped.
    const maxCreatedAt = new Date(rows[rows.length - 1].created_at);

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
      this.lastSettledAt = maxCreatedAt;
      await this.saveHighWaterMark(maxCreatedAt);
      return;
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
      // to reprocess them on every restart (lastSettledAt is in-memory),
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

    // 2c. BUG 012 FIX — Refresh player_stats.hands_played + total_rake per (user, club).
    // Engine never writes player_stats; table was frozen 22 days. 7 client readers show
    // stale data. Aggregate per-user hand count + rake credit from rake_records and upsert.
    type PlayerStatsBucket = { user_id: string; club_id: string; hands: number; rake: number };
    const psBuckets = new Map<string, PlayerStatsBucket>();
    for (const row of rows as RakeRecordRow[]) {
      if (!row.player_contributions) continue;
      const dealtIn = Object.entries(row.player_contributions).filter(([, a]) => Number(a) > 0);
      if (dealtIn.length === 0) continue;
      // RAKE-AUDIT 2026-07-24: exact integer-cents split (shares sum to rake)
      const psShares = equalShareCents(
        Number(row.rake_amount),
        dealtIn.map(([uid]) => uid)
      );
      for (const [userId] of dealtIn) {
        const share = psShares.get(userId) ?? 0;
        const key = `${userId}:${row.club_id}`;
        const b = psBuckets.get(key);
        if (b) {
          b.hands += 1;
          b.rake = Math.round((b.rake + share) * 100) / 100;
        } else {
          psBuckets.set(key, { user_id: userId, club_id: row.club_id, hands: 1, rake: share });
        }
      }
    }
    let psUpserts = 0;
    let psFailures = 0;
    for (const pb of psBuckets.values()) {
      const { data: existing } = await supabase
        .from('player_stats')
        .select('id, hands_played, total_rake')
        .eq('user_id', pb.user_id)
        .eq('club_id', pb.club_id)
        .maybeSingle();
      if (existing) {
        const { error } = await supabase
          .from('player_stats')
          .update({
            hands_played: (existing.hands_played ?? 0) + pb.hands,
            total_rake: Math.round(((existing.total_rake ?? 0) + pb.rake) * 100) / 100,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        if (error) {
          psFailures++;
        } else {
          psUpserts++;
        }
      } else {
        const { error } = await supabase.from('player_stats').insert({
          user_id: pb.user_id,
          club_id: pb.club_id,
          hands_played: pb.hands,
          total_rake: pb.rake,
          total_winnings: 0,
          total_losses: 0,
          vpip: 0,
          pfr: 0,
          tournaments_played: 0,
          tournaments_won: 0,
        });
        if (error) {
          psFailures++;
        } else {
          psUpserts++;
        }
      }
    }
    if (psBuckets.size > 0) {
      console.log(
        `[RakebackSettler] player_stats upserts: ${psUpserts}/${psBuckets.size} OK (failures: ${psFailures})`
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
    this.lastSettledAt = maxCreatedAt;
    await this.saveHighWaterMark(maxCreatedAt);
  }
}
