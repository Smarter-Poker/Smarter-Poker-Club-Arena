import type { AccountingObservationInput } from '../../src/services/AccountingObservationService';
export const OBSERVER_ID = {
  actor: 'aa000000-0000-0000-0000-000000000001',
  otherActor: 'aa000000-0000-0000-0000-000000000002',
  union: 'bb000000-0000-0000-0000-000000000001',
  otherUnion: 'bb000000-0000-0000-0000-000000000002',
  club: 'cc000000-0000-0000-0000-000000000001',
  period: 'dd000000-0000-0000-0000-000000000001',
};
export const observationInput: AccountingObservationInput = {
  actorId: OBSERVER_ID.actor,
  scopeKind: 'union',
  scopeId: OBSERVER_ID.union,
  periodStart: '2026-09-07T07:00:00.000Z',
  periodEnd: '2026-09-14T07:00:00.000Z',
};
/** Synthetic public v1 DTO; no financial result or provider receipt is implied. */
export function observationRow(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 1,
    actor_user_id: OBSERVER_ID.actor,
    scope_kind: 'union',
    scope_id: OBSERVER_ID.union,
    period_start: observationInput.periodStart,
    period_end: observationInput.periodEnd,
    observed_at: '2026-09-14T10:00:00.000001Z',
    expected_run_at: '2026-09-14T09:00:00.000Z',
    record_found: true,
    state: 'posted',
    recorded_scheduled_at: '2026-09-14T09:00:00.000Z',
    attempts: 1,
    started_at: '2026-09-14T09:00:00.000001Z',
    finished_at: '2026-09-14T09:00:01.000001Z',
    posted: true,
    ...overrides,
  };
}
export function missingObservation(kind: 'club' | 'union' = 'union', scopeId = OBSERVER_ID.union) {
  return observationRow({
    scope_kind: kind,
    scope_id: scopeId,
    record_found: false,
    state: kind === 'club' ? 'unavailable' : 'no_recorded_run',
    recorded_scheduled_at: null,
    attempts: null,
    started_at: null,
    finished_at: null,
    posted: false,
  });
}
export function recordedPeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: OBSERVER_ID.period,
    club_id: null,
    union_id: OBSERVER_ID.union,
    period_number: 37,
    year: 2026,
    start_at: observationInput.periodStart,
    end_at: observationInput.periodEnd,
    status: 'closed',
    total_rake_collected: '10.25',
    total_bbj_contributions: '0.00',
    total_player_winnings: null,
    total_player_losses: null,
    total_hands_dealt: 59,
    settled_at: null,
    settled_by: null,
    ...overrides,
  };
}
