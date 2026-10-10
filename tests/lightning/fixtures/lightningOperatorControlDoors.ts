/**
 * LIGHTNING PHASE 13: operator control door answers, in exactly the shapes
 * the database builds them (branch agent/claude-lightning-p13/lightning/
 * rollout-drain-db):
 *
 *   fn_lightning_operator_cluster_row      Phase 12's row plus paused, paused_from,
 *                                          joins_enabled, drain, matcher, flags
 *   fn_lightning_operator_control          {ok, idempotent, action, cluster_id, request_id,
 *                                           before, after, event_id}
 *   fn_lightning_rollout_readiness         {ok, cluster_id, verdict, reasons, checks}
 *   refusals                               {ok:false, code, reason}
 *
 * Nothing here is a field the database cannot produce. Shared by the unit
 * tests and the #ClubArenaConsole render harness (harnessDoor).
 */
import {
  CLUSTER_A,
  CLUSTER_B,
  CLUSTER_C,
  MISSING_FUNCTION_ERROR,
  clusterAnswer,
  overviewAnswer,
  overviewCluster,
} from './lightningOperatorDoors';

export { CLUSTER_A, CLUSTER_B, CLUSTER_C, CLUB_ID } from './lightningOperatorDoors';

export const OPERATOR = '12121212-1212-4212-8212-121212121212';
const AT = '2026-10-09T14:00:00.000Z';

/** The Spec's flags with their effective values, as the row reports them. */
export function specFlags(over: Record<string, boolean> = {}) {
  return {
    lightning_v1: true,
    lightning_fast_fold: true,
    lightning_fold_watch: true,
    lightning_multi_table: true,
    lightning_pool_health: true,
    lightning_repeat_suppression: true,
    lightning_session_stats: true,
    lightning_shadow_matcher: true,
    lightning_auto_rebuy: false,
    lightning_adaptive_liquidity: true,
    ...over,
  };
}

export function matcher(over: Record<string, unknown> = {}) {
  return { version: 'm1', previous: 'm1', disabled: [], shadow_version: 'm2', ...over };
}

/** The Phase 13 keys of fn_lightning_operator_cluster_row. */
export function controlKeys(over: Record<string, unknown> = {}) {
  return {
    paused: false,
    paused_from: null,
    joins_enabled: true,
    drain: null,
    matcher: matcher(),
    ...over,
  };
}

/** One overview row as Phase 13 builds it: Phase 12's keys, flags widened. */
export function controlCluster(over: Record<string, unknown> = {}) {
  const base = overviewCluster() as Record<string, unknown>;
  return {
    ...base,
    flags: { ...(base.flags as Record<string, unknown>), ...specFlags() },
    ...controlKeys(),
    ...over,
  };
}

export function drainState(over: Record<string, unknown> = {}) {
  return {
    phase: 'finish_hands',
    requested_at: '2026-10-09T13:59:10.000Z',
    requested_by: OPERATOR,
    reason: 'Emergency drain for the 22:00 maintenance',
    deadline_at: '2026-10-09T14:01:10.000Z',
    instances_remaining: 3,
    hands_remaining: 2,
    sessions_remaining: 14,
    ...over,
  };
}

export function overviewAnswer13() {
  const a = overviewAnswer();
  return {
    ...a,
    clusters: a.clusters.map((c: Record<string, unknown>, i: number) => ({
      ...c,
      flags: { ...(c.flags as Record<string, unknown>), ...specFlags() },
      ...controlKeys(
        i === 0
          ? { drain: drainState(), joins_enabled: false }
          : i === 1
            ? { paused: true, paused_from: 'lightning' }
            : {}
      ),
    })),
  };
}

export function clusterAnswer13(row: Record<string, unknown> = {}) {
  return { ...clusterAnswer(), cluster: controlCluster(row) };
}

export function stateOf(row: Record<string, unknown>) {
  return {
    cluster_mode: row.cluster_mode,
    lightning_enabled: row.lightning_enabled,
    paused: row.paused,
    joins_enabled: row.joins_enabled,
    drain: row.drain,
    matcher: row.matcher,
  };
}

export function controlAnswer(
  action: string,
  requestId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  idempotent = false
) {
  return {
    ok: true,
    idempotent,
    action,
    cluster_id: CLUSTER_A,
    request_id: requestId,
    before: stateOf(before),
    after: stateOf(after),
    event_id: 90417,
  };
}

export function refusal(code: string) {
  return { ok: false, code, reason: code };
}

export function readinessAnswer(verdict: 'go' | 'no_go' | 'insufficient_evidence' = 'no_go') {
  return {
    ok: true,
    cluster_id: CLUSTER_A,
    as_of: AT,
    verdict,
    reasons:
      verdict === 'go'
        ? []
        : [
            { code: 'OPEN_ALERTS', detail: '1 Open Lightning Alert' },
            { code: 'SHADOW_INSUFFICIENT', detail: 'Candidate m2 Has 12 Of 30 Comparisons' },
          ],
    checks: {
      migrations_applied: { ok: true, detail: '20261009181945' },
      not_frozen: { ok: true },
      open_alerts: { ok: verdict === 'go', value: verdict === 'go' ? 0 : 1 },
      shadow_verdict: { ok: verdict === 'go', detail: 'insufficient_evidence' },
      latency_p95_within_ceiling: { ok: true },
      integrity_open_high: { ok: true, value: 0 },
      live_eligible_vs_on: { ok: true, detail: '23 / 18' },
      worker_mode: { ok: true, detail: 'form' },
    },
  };
}

/** The render harness's doors, by scenario. Undefined: the harness default. */
export function harnessDoor(fn: string, args: Record<string, unknown>, scenario: string) {
  const ok = (data: unknown) => ({ data, error: null });
  if (fn === 'fn_lightning_operator_overview') return ok(overviewAnswer13());
  if (fn === 'fn_lightning_operator_cluster') {
    if (scenario === 'draining') {
      return ok(
        clusterAnswer13({
          cluster_mode: 'draining',
          joins_enabled: false,
          drain: drainState(),
        })
      );
    }
    if (scenario === 'frozen') {
      return ok({
        ...clusterAnswer13({
          cluster_id: CLUSTER_C,
          name: 'NLH 5/10 Lightning',
          cluster_mode: 'frozen',
          lightning_enabled: false,
          frozen: {
            at: '2026-10-09T12:02:00.000Z',
            reason: 'LIGHTNING_FORMATION_MOVED_MONEY',
            invariant: null,
          },
        }),
      });
    }
    if (scenario === 'paused') {
      return ok(
        clusterAnswer13({ paused: true, paused_from: 'lightning', cluster_mode: 'paused' })
      );
    }
    return ok(clusterAnswer13());
  }
  if (fn === 'fn_lightning_rollout_readiness') {
    if (scenario === 'missing') return { data: null, error: { ...MISSING_FUNCTION_ERROR } };
    return ok(readinessAnswer(scenario === 'go' ? 'go' : 'no_go'));
  }
  if (fn === 'fn_lightning_operator_control') {
    const p = (args.p_args ?? {}) as Record<string, unknown>;
    const id = String(p.request_id ?? '');
    if (scenario === 'refused') return ok(refusal('CLUSTER_BUSY'));
    const before = controlCluster();
    const action = String(args.p_action);
    const after =
      action === 'pause'
        ? controlCluster({ paused: true, paused_from: 'lightning', cluster_mode: 'paused' })
        : action === 'drain'
          ? controlCluster({
              cluster_mode: 'draining',
              joins_enabled: false,
              drain: drainState({ phase: 'stop_joins' }),
            })
          : action === 'disable_joins'
            ? controlCluster({ joins_enabled: false })
            : controlCluster();
    return ok(controlAnswer(action, id, before, after));
  }
  return undefined;
}
