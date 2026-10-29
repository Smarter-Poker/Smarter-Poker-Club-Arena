/** Process-root Data API door for the original weekly payout boundary.
 * Realtime carries only a wake; every decision is read back from PostgreSQL.
 */
import { performance } from 'node:perf_hooks';
import { supabase } from '../services/supabase/client.js';
import { bindToProcessRoot } from '../services/supabase/dataActorContext.js';
import type { WeeklyPayoutBoundary, WeeklyPayoutIdentity } from './WeeklyPayoutPause.js';

export interface WeeklyPayoutLeaseClaim {
  table_id: string | null;
  scope: 'cash' | 'tournament';
  lease_generation: string;
  tournament_id: string | null;
}

export class WeeklyPayoutDatabaseClock {
  private observedAt: number | null = null;
  private receivedAt = 0;
  constructor(private readonly monotonicNow: () => number = () => performance.now()) {}
  observe(databaseTime: string): void {
    const parsed = Date.parse(databaseTime);
    if (!Number.isFinite(parsed)) throw new Error('weekly_payout_database_clock_invalid');
    const receivedAt = this.monotonicNow();
    const priorLowerBound =
      this.observedAt === null
        ? parsed
        : this.observedAt + Math.max(0, receivedAt - this.receivedAt);
    this.observedAt = Math.max(parsed, priorLowerBound);
    this.receivedAt = receivedAt;
  }
  now(): number {
    if (this.observedAt === null) throw new Error('weekly_payout_database_clock_unread');
    // The response was produced BEFORE receipt. This lower bound cannot lift
    // gameplay early even when the host wall clock jumps or the RPC is slow.
    return this.observedAt + Math.max(0, this.monotonicNow() - this.receivedAt);
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
    throw new Error('weekly_payout_timestamp_invalid');
  return Date.parse(value);
}

export function createWeeklyPayoutPauseStore(
  instanceId: string,
  claims: () => WeeklyPayoutLeaseClaim[]
) {
  const clock = new WeeklyPayoutDatabaseClock();
  function decode(value: unknown): WeeklyPayoutBoundary | null {
    if (!value || typeof value !== 'object') throw new Error('weekly_payout_state_invalid');
    const response = value as Record<string, unknown>;
    if (response.contract !== 'weekly-payout-owned-phase-v1')
      throw new Error('weekly_payout_database_contract_unavailable');
    clock.observe(String(response.observed_at));
    if (response.boundary === null) return null;
    const b = response.boundary as Record<string, unknown>;
    if (!b || typeof b !== 'object') throw new Error('weekly_payout_boundary_unread');
    return {
      runId: String(b.run_id),
      ownershipToken: String(b.ownership_token),
      scopeKind: String(b.scope_kind) as WeeklyPayoutBoundary['scopeKind'],
      scopeId: String(b.scope_id),
      periodStart: new Date(timestamp(b.period_start)).toISOString(),
      periodEnd: new Date(timestamp(b.period_end)).toISOString(),
      announcedAt: timestamp(b.announced_at),
      moneyStartsAt: timestamp(b.money_starts_at),
      expiresAt: timestamp(b.expires_at),
      moneyDeadlineAt: timestamp(b.money_deadline_at),
      phase: String(b.phase) as WeeklyPayoutBoundary['phase'],
    };
  }
  const readCurrent = bindToProcessRoot(async (expected?: WeeklyPayoutIdentity) => {
    const { data, error } = await supabase.rpc('fn_weekly_accounting_payout_pause_state', {
      p_run_id: expected?.runId ?? null,
      p_ownership_token: expected?.ownershipToken ?? null,
    });
    if (error) throw new Error('weekly_payout_state_read_unknown');
    return decode(data);
  });
  return {
    clock,
    readCurrent,
    read: bindToProcessRoot(
      async (expected: WeeklyPayoutIdentity): Promise<WeeklyPayoutBoundary> => {
        const result = await readCurrent(expected);
        if (!result) throw new Error('weekly_payout_original_owner_unread');
        return result;
      }
    ),
    admit: bindToProcessRoot(
      async (expected: WeeklyPayoutBoundary): Promise<WeeklyPayoutBoundary> => {
        const { data, error } = await supabase.rpc('fn_weekly_accounting_payout_pause_ack', {
          p_run_id: expected.runId,
          p_ownership_token: expected.ownershipToken,
          p_instance_id: instanceId,
          p_claims: claims(),
        });
        if (error) throw new Error('weekly_payout_admission_unknown');
        const result = decode(data);
        if (!result) throw new Error('weekly_payout_acknowledged_owner_unread');
        return result;
      }
    ),
  };
}
