/**
 * LIGHTNING PHASE 13: operator control door answers, in exactly the shapes
 * the database builds them (migration 20261009235505, branch
 * agent/claude-lightning-p13/lightning/rollout-drain-db):
 *
 *   fn_lightning_operator_cluster_row      Phase 12's row plus paused, paused_from,
 *                                          joins_enabled, drain, matcher,
 *                                          integrity_open_high, and the ten Spec
 *                                          flags inside flags (fn_lightning_spec_flags)
 *   fn_lightning_operator_state            <state>: cluster_mode, cluster_epoch,
 *                                          lightning_enabled, paused, paused_from,
 *                                          joins_enabled, drain, matcher, flags
 *   fn_lightning_operator_control          {ok, idempotent, action, cluster_id, request_id,
 *                                           before, after, event_id, detail};
 *                                          a no-op adds already:true, code ALREADY;
 *                                          a repeated request id adds replayed:true
 *   fn_lightning_rollout_readiness         {ok, cluster_id, as_of, verdict,
 *                                           reasons:[{code, severity, detail}], evidence}
 *   transitions                            {kind:'operator'|'drain', at, event_id,
 *                                           event_kind, cluster_epoch, request_id, payload}
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
  return {
    version: 'm1',
    previous: 'm1',
    disabled: [],
    shadow_version: 'm2',
    shadow_disabled: false,
    ...over,
  };
}

/** The Phase 13 keys of fn_lightning_operator_cluster_row. */
export function controlKeys(over: Record<string, unknown> = {}) {
  return {
    paused: false,
    paused_from: null,
    joins_enabled: true,
    drain: null,
    matcher: matcher(),
    integrity_open_high: 1,
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

export const DRAIN_ID = 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1';

/** The row's drain object (fn_lightning_operator_cluster_row). */
export function drainState(over: Record<string, unknown> = {}) {
  return {
    drain_id: DRAIN_ID,
    phase: 'finishing',
    requested_at: '2026-10-09T13:59:10.000Z',
    requested_by: OPERATOR,
    reason: 'Emergency drain for the 22:00 maintenance',
    from_mode: 'lightning',
    deadline_at: '2026-10-09T14:01:10.000Z',
    overdue: false,
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

/** fn_lightning_operator_state: the drain inside it is the short form. */
export function stateOf(row: Record<string, unknown>) {
  const d = row.drain as Record<string, unknown> | null;
  return {
    cluster_mode: row.cluster_mode,
    cluster_epoch: row.cluster_epoch,
    lightning_enabled: row.lightning_enabled,
    paused: row.paused,
    paused_from: row.paused_from,
    joins_enabled: row.joins_enabled,
    drain: d
      ? {
          drain_id: d.drain_id,
          phase: d.phase,
          from_mode: d.from_mode,
          requested_at: d.requested_at,
          deadline_at: d.deadline_at,
        }
      : null,
    matcher: row.matcher,
    flags: row.flags,
  };
}

export function controlAnswer(
  action: string,
  requestId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  replayed = false
) {
  const answer = {
    ok: true,
    idempotent: false,
    action,
    cluster_id: CLUSTER_A,
    request_id: requestId,
    before: stateOf(before),
    after: stateOf(after),
    event_id: 90417,
    detail: {},
  };
  // A repeated request id answers the first answer with these two added.
  return replayed ? { ...answer, idempotent: true, replayed: true } : answer;
}

/** The door's no-op: the Cluster was already there. */
export function alreadyAnswer(action: string, requestId: string, row: Record<string, unknown>) {
  return {
    ok: true,
    idempotent: true,
    already: true,
    code: 'ALREADY',
    action,
    cluster_id: CLUSTER_A,
    request_id: requestId,
    before: stateOf(row),
    after: stateOf(row),
    event_id: null,
    detail: {},
  };
}

/** Two transitions the cluster door now carries: an operator action and a
 *  drain step (cash_cluster_events kinds operator_<action>, lightning_drain_step). */
export function operatorTransitions() {
  const req = 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1';
  return [
    {
      kind: 'drain',
      at: '2026-10-09T13:59:10.200Z',
      event_id: 90418,
      event_kind: 'lightning_drain_step',
      cluster_epoch: 4,
      request_id: req,
      payload: {
        step: 3,
        name: 'let_active_hands_finish',
        hands_in_flight: 2,
        drain_id: DRAIN_ID,
        request_id: req,
        operator_event_id: 90417,
        at: '2026-10-09T13:59:10.200Z',
      },
    },
    {
      kind: 'operator',
      at: '2026-10-09T13:59:10.000Z',
      event_id: 90417,
      event_kind: 'operator_drain',
      cluster_epoch: 4,
      request_id: req,
      payload: {
        action: 'drain',
        actor: OPERATOR,
        actor_kind: 'club_control',
        reason: 'Emergency drain for the 22:00 maintenance',
        request_id: req,
        args: {},
        before: {},
        after: {},
        detail: {},
        at: '2026-10-09T13:59:10.000Z',
      },
    },
  ];
}

export function refusal(code: string) {
  return { ok: false, code, reason: code };
}

export function readinessAnswer(verdict: 'go' | 'no_go' | 'insufficient_evidence' = 'no_go') {
  const reasons =
    verdict === 'go'
      ? []
      : verdict === 'insufficient_evidence'
        ? [{ code: 'NO_AA_CALIBRATION', severity: 'evidence', detail: null }]
        : [
            { code: 'OPEN_ALERTS', severity: 'blocking', detail: 1 },
            { code: 'INTEGRITY_HIGH_SIGNALS_OPEN', severity: 'blocking', detail: 1 },
            {
              code: 'WORKER_SHADOW_ONLY',
              severity: 'evidence',
              detail: 'worker_mode shadow plans and compares and forms no hands',
            },
            { code: 'NO_AA_CALIBRATION', severity: 'evidence', detail: null },
          ];
  return {
    ok: true,
    cluster_id: CLUSTER_A,
    as_of: AT,
    verdict,
    reasons,
    evidence: {
      migrations: { expected: 41, applied: 41, missing: [] },
      invariants: {
        seven_tables: true,
        anti_manipulation: true,
        law_10_5: true,
        no_anon_door: true,
        proofs_evaluated_in_sql: false,
      },
      cluster: {
        cluster_mode: 'lightning',
        lightning_enabled: true,
        game_enabled: true,
        must_move: true,
        frozen: false,
        paused: false,
        drain_open: false,
        worker_mode: verdict === 'go' ? 'form' : 'shadow',
        live_eligible: 23,
        on_threshold: 18,
        off_threshold: 12,
        would_turn_on: true,
        club_is_public: false,
        game_is_private: false,
      },
      alerts: { open: verdict === 'no_go' ? 1 : 0 },
      integrity: { open: 2, open_high: verdict === 'no_go' ? 1 : 0 },
      shadow: {
        scope: 'cluster',
        aa_calibration: null,
        candidate: {
          live_matcher_version: 'm1',
          shadow_matcher_version: 'm2',
          comparisons: 12,
          verdict: 'insufficient_evidence',
        },
      },
      latency: { latest_window_to: AT, over: [] },
      matcher: matcher(),
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
          lightning_enabled: false,
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
    return ok({
      ...clusterAnswer13(),
      transitions: [...operatorTransitions(), ...clusterAnswer().transitions],
    });
  }
  if (fn === 'fn_lightning_rollout_readiness') {
    if (scenario === 'missing') return { data: null, error: { ...MISSING_FUNCTION_ERROR } };
    return ok(readinessAnswer(scenario === 'go' ? 'go' : 'no_go'));
  }
  if (fn === 'fn_lightning_operator_control') {
    const p = (args.p_args ?? {}) as Record<string, unknown>;
    const id = String(p.request_id ?? '');
    if (scenario === 'refused') return ok(refusal('CLUSTER_BUSY'));
    // A club operator asking to unfreeze: only a platform administrator may.
    if (scenario === 'frozen') return ok(refusal('NOT_AUTHORIZED'));
    const before = controlCluster();
    const action = String(args.p_action);
    const after =
      action === 'pause'
        ? controlCluster({ paused: true, paused_from: 'lightning', cluster_mode: 'paused' })
        : action === 'drain'
          ? controlCluster({
              cluster_mode: 'draining',
              joins_enabled: false,
              lightning_enabled: false,
              drain: drainState(),
            })
          : action === 'disable_joins'
            ? controlCluster({ joins_enabled: false })
            : controlCluster();
    return ok(controlAnswer(action, id, before, after));
  }
  return undefined;
}
