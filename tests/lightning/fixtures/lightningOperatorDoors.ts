/**
 * LIGHTNING PHASE 12: operator door answers, in exactly the shapes the
 * database builds them (migration 20261009144343, branch
 * agent/claude-lightning-p12/lightning/operator-alerts-db):
 *
 *   fn_lightning_operator_cluster_row      every overview / cluster row
 *   fn_lightning_operator_overview         {ok, club_id, as_of, truncated, clusters}
 *   fn_lightning_operator_cluster          {ok, cluster_id, from, to, window_clamped, cluster,
 *                                           transitions, reservations, blind_ledger, reconcile,
 *                                           shadow_report, integrity_signals, alerts,
 *                                           latency_windows, quality, matcher_passes}
 *   fn_lightning_operator_hand_replay      {ok, cluster_id, hand_id, replay, hand, players, events}
 *   fn_lightning_operator_session_trail    {ok, cluster_id, pool_session, trail, transitions}
 *   fn_lightning_operator_signal_review    {ok, idempotent, signal_id, cluster_id, status, ...}
 *   refusals                               {ok:false, code, reason}
 *
 * Nothing here is a field the database cannot produce. Shared by the unit
 * tests and the #ClubArenaConsole render harness.
 */

export const CLUB_ID = '11111111-1111-4111-8111-111111111111';
export const CLUSTER_A = '22222222-2222-4222-8222-222222222222';
export const CLUSTER_B = '33333333-3333-4333-8333-333333333333';
export const CLUSTER_C = '44444444-4444-4444-8444-444444444444';
export const POOL_SESSION = '55555555-5555-4555-8555-555555555555';
export const HAND_ID = '66666666-6666-4666-8666-666666666666';
const PLAYER_1 = '77777777-7777-4777-8777-777777777777';
const PLAYER_2 = '88888888-8888-4888-8888-888888888888';
const PLAYER_3 = '99999999-9999-4999-8999-999999999999';
const INSTANCE = 'abababab-abab-4bab-8bab-abababababab';
const SLOT = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const CONVERSION = 'efefefef-efef-4fef-8fef-efefefefefef';

const AT = '2026-10-09T14:00:00.000Z';

function legs() {
  return {
    fold_ack: { n: 412, p50: 38, p95: 91, p99: 140 },
    ack_to_idle: { n: 412, p50: 4, p95: 11, p99: 19 },
    idle_to_match: { n: 398, p50: 210, p95: 640, p99: 1180 },
    match_to_hand: { n: 398, p50: 55, p95: 120, p99: 210 },
    fast_fold_to_next_hand: { n: 301, p50: 410, p95: 980, p99: 1600 },
    normal_fold_to_next_hand: { n: 61, p50: 2200, p95: 4100, p99: 5300 },
    fold_watch_to_next_hand: { n: 36, p50: 3100, p95: 6200, p99: 7400 },
  };
}

/** fn_lightning_operator_cluster_row's object, key for key. */
export function overviewCluster(over: Record<string, unknown> = {}) {
  return {
    cluster_id: CLUSTER_A,
    name: 'NLH 1/2 Lightning',
    variant: 'nlh',
    sb: 1,
    bb: 2,
    handedness: 6,
    lightning_enabled: true,
    cluster_mode: 'lightning',
    cluster_epoch: 4,
    mode_since: '2026-10-09T13:20:00.000Z',
    on_threshold: 18,
    off_threshold: 12,
    live_eligible: 23,
    worker_mode: 'form',
    flags: {
      shadow_matcher: true,
      integrity_telemetry: true,
      auto_rebuy: false,
      latency_telemetry: true,
    },
    pool: { joining: 1, eligibility_check: 0, active: 19, sit_out: 2, disconnected: 1, leaving: 0 },
    reservations: { pending: 3, committed: 12 },
    instances: { forming: 1, reserved: 0, dealing: 3, settling: 1 },
    orphan_reservations: 0,
    blind_obligations_open: 2,
    stuck_conversion: null,
    frozen: null,
    open_alerts: 0,
    integrity_open_signals: 2,
    shadow: {
      verdict: 'insufficient_evidence',
      comparisons: 12,
      delta_mean: 1.84,
      live_matcher_version: 'm1',
      shadow_matcher_version: 'm2',
    },
    latency: { window_from: '2026-10-09T13:59:00.000Z', window_to: AT, legs: legs() },
    ...over,
  };
}

export function overviewAnswer() {
  return {
    ok: true,
    club_id: CLUB_ID,
    as_of: AT,
    truncated: false,
    clusters: [
      overviewCluster(),
      overviewCluster({
        cluster_id: CLUSTER_B,
        name: 'PLO 2/5 Lightning',
        variant: 'plo',
        sb: 2,
        bb: 5,
        handedness: 9,
        cluster_mode: 'pending_off',
        cluster_epoch: 7,
        mode_since: '2026-10-09T13:30:00.000Z',
        on_threshold: 27,
        off_threshold: 18,
        live_eligible: 16,
        stuck_conversion: {
          conversion_id: CONVERSION,
          from_mode: 'lightning',
          to_mode: 'must_move',
          opened_at: '2026-10-09T13:30:00.000Z',
          age_ms: 1_800_000,
          threshold_ms: 1_200_000,
        },
        orphan_reservations: 1,
        open_alerts: 1,
        integrity_open_signals: 0,
        shadow: null,
        latency: null,
      }),
      overviewCluster({
        cluster_id: CLUSTER_C,
        name: 'NLH 5/10 Lightning',
        sb: 5,
        bb: 10,
        lightning_enabled: false,
        cluster_mode: 'frozen',
        cluster_epoch: 2,
        mode_since: '2026-10-09T12:02:00.000Z',
        live_eligible: 0,
        worker_mode: 'off',
        flags: {
          shadow_matcher: false,
          integrity_telemetry: false,
          auto_rebuy: false,
          latency_telemetry: true,
        },
        pool: {
          joining: 0,
          eligibility_check: 0,
          active: 0,
          sit_out: 0,
          disconnected: 0,
          leaving: 0,
        },
        reservations: { pending: 0, committed: 0 },
        instances: { forming: 0, reserved: 0, dealing: 0, settling: 0 },
        blind_obligations_open: 0,
        frozen: {
          at: '2026-10-09T12:02:00.000Z',
          reason: 'LIGHTNING_FORMATION_MOVED_MONEY',
          invariant: null,
        },
        open_alerts: 1,
        integrity_open_signals: 0,
        shadow: null,
        latency: null,
      }),
    ],
  };
}

export function clusterAnswer() {
  return {
    ok: true,
    cluster_id: CLUSTER_A,
    from: '2026-10-08T14:00:00.000Z',
    to: AT,
    window_clamped: false,
    cluster: overviewCluster(),
    transitions: [
      {
        kind: 'epoch',
        at: '2026-10-09T13:20:00.000Z',
        epoch: 4,
        mode: 'lightning',
        started_by: 'commit_lightning',
        ended_at: null,
      },
      {
        kind: 'conversion',
        at: '2026-10-09T13:19:40.000Z',
        conversion_id: CONVERSION,
        from_mode: 'must_move',
        to_mode: 'lightning',
        status: 'committed',
        abort_reason: null,
        trigger_population: 18,
        on_threshold: 18,
        off_threshold: 12,
        epoch_before: 3,
        epoch_after: 4,
        opened_at: '2026-10-09T13:19:40.000Z',
        closed_at: '2026-10-09T13:20:00.000Z',
        chips_at_begin: '9e107d9d372bb6826bd81d3542a419d6',
        chips_at_commit: '9e107d9d372bb6826bd81d3542a419d6',
      },
      {
        kind: 'epoch',
        at: '2026-10-09T11:05:00.000Z',
        epoch: 3,
        mode: 'must_move',
        started_by: 'commit_must_move',
        ended_at: '2026-10-09T13:20:00.000Z',
      },
    ],
    reservations: [
      {
        reservation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        player_id: PLAYER_1,
        state: 'pending',
        seat_number: 3,
        instance_id: INSTANCE,
        instance_state: 'forming',
        created_at: '2026-10-09T13:59:50.000Z',
        expires_at: '2026-10-09T14:00:05.000Z',
        orphan: false,
      },
    ],
    blind_ledger: [
      {
        player_id: PLAYER_2,
        missed_bb_debt: 1,
        missed_sb_debt: 0,
        bb_owed: 2,
        sb_owed: 0,
        debt_since: '2026-10-09T13:58:00.000Z',
        bb_count: 14,
        sb_count: 15,
      },
    ],
    reconcile: [
      {
        pool_session_id: POOL_SESSION,
        player_id: PLAYER_1,
        state: 'active',
        anchor_seat_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        anchor_stack: 412,
        exposure: 12,
        pool_stack: 400,
        ok: true,
      },
      {
        pool_session_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        player_id: PLAYER_3,
        state: 'active',
        anchor_seat_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        anchor_stack: 1500,
        exposure: 0,
        pool_stack: 1380,
        ok: false,
      },
    ],
    shadow_report: {
      ok: true,
      cluster_id: CLUSTER_A,
      from: '2026-10-08T14:00:00.000Z',
      to: AT,
      version_pairs: [
        {
          live_matcher_version: 'm1',
          shadow_matcher_version: 'm2',
          comparisons: 12,
          clusters: 1,
          first_window_from: '2026-10-09T02:00:00.000Z',
          last_window_to: AT,
          live_quality_mean: 71.2,
          shadow_quality_mean: 73.04,
          quality_delta_mean: 1.84,
          quality_delta_min: -2.1,
          quality_delta_max: 4.6,
          shadow_better_share: 0.6667,
          metrics: {
            'component.bb_fairness': { live: 0.92, shadow: 0.95, delta: 0.03 },
            'component.opponent_diversity': { live: 0.61, shadow: 0.7, delta: 0.09 },
            'wait_ms.p95': { live: 640, shadow: 590, delta: -50 },
          },
          verdict: 'insufficient_evidence',
        },
      ],
    },
    integrity_signals: [
      {
        id: 41,
        pattern_type: 'PAIRING_CONCENTRATION',
        source: 'scan',
        player_a: PLAYER_1,
        player_b: PLAYER_2,
        window_start: '2026-10-08T13:00:00.000Z',
        window_end: '2026-10-09T13:00:00.000Z',
        suspicion_score: 75,
        severity: 'high',
        status: 'open',
        detected_at: '2026-10-09T13:05:00.000Z',
        reviewed_by: null,
        reviewed_at: null,
        notes: null,
        evidence: { hands_together: 64, expected: 14.2, ratio: 4.5 },
      },
    ],
    alerts: [
      {
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        severity: 'warning',
        source: 'lightning_alerts',
        check: 'latency_regression',
        message:
          "LIGHTNING_LATENCY_REGRESSION: Lightning Cluster NLH 1/2 Lightning (22222222-2222-4222-8222-222222222222) leg fold_ack has had a p95 above 500 ms in each of its last 3 windows. Measure before optimizing; the windows are in this alert's context.",
        created_at: '2026-10-09T13:40:00.000Z',
        dedupe_key: `lightning_latency_regression:${CLUSTER_A}:fold_ack`,
      },
    ],
    latency_windows: [
      { window_from: '2026-10-09T13:59:00.000Z', window_to: AT, legs: legs() },
      {
        window_from: '2026-10-09T13:58:00.000Z',
        window_to: '2026-10-09T13:59:00.000Z',
        legs: { ...legs(), fold_ack: { n: 380, p50: 41, p95: 99, p99: 150 } },
      },
      {
        window_from: '2026-10-09T13:57:00.000Z',
        window_to: '2026-10-09T13:58:00.000Z',
        legs: { ...legs(), fold_ack: { n: 377, p50: 36, p95: 84, p99: 131 } },
      },
    ],
    quality: {
      window_from: '2026-10-09T13:00:00.000Z',
      window_to: AT,
      live_matcher_version: 'm1',
      shadow_matcher_version: 'm2',
      live_quality_score: 71.2,
      shadow_quality_score: 73.04,
      live_components: { bb_fairness: 0.92 },
      shadow_components: { bb_fairness: 0.95 },
      quality_weights: { bb_fairness: 0.2 },
    },
    matcher_passes: [
      {
        request_id: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
        cluster_epoch: 4,
        matcher_version: 'm1',
        started_at: '2026-10-09T13:59:58.000Z',
        finished_at: '2026-10-09T13:59:58.020Z',
        hands_formed: 2,
        result: { formed: 2 },
      },
    ],
  };
}

export function handReplayAnswer(defects = false) {
  return {
    ok: true,
    cluster_id: CLUSTER_A,
    hand_id: HAND_ID,
    replay: {
      ok: !defects,
      hand_id: HAND_ID,
      cluster_id: CLUSTER_A,
      cluster_epoch: 4,
      settled: true,
      defects: defects ? [{ code: 'conservation', net_sum: 2, rake: 1, bbj: 0 }] : [],
    },
    hand: {
      hand_id: HAND_ID,
      hand_number: 1042,
      cluster_epoch: 4,
      lightning_instance_id: INSTANCE,
      instance_state: 'complete',
      formed_at: '2026-10-09T13:58:00.000Z',
      settled_at: '2026-10-09T13:58:40.000Z',
      player_count: 2,
      hand_history_id: null,
      rules_version: 'r1',
      matcher_version: 'm1',
      blind_algorithm_version: 'b1',
      lightning_version: 'l1',
      rake_version: 'k1',
      rake: 1,
      bbj: 0,
    },
    players: [
      {
        player_id: PLAYER_1,
        seat: 1,
        position: 'SB',
        blind_role: 'sb',
        stack_before: 400,
        stack_after: 412,
        net_result: 12,
        fold_type: null,
        folded_at: null,
        committed_at_fold: null,
        waited_ms: 640,
        showed: true,
      },
      {
        player_id: PLAYER_2,
        seat: 2,
        position: 'BB',
        blind_role: 'bb',
        stack_before: 300,
        stack_after: 287,
        net_result: -13,
        fold_type: 'fast_fold',
        folded_at: '2026-10-09T13:58:10.000Z',
        committed_at_fold: 13,
        waited_ms: 220,
        showed: false,
      },
    ],
    events: [],
  };
}

export function sessionTrailAnswer() {
  return {
    ok: true,
    cluster_id: CLUSTER_A,
    pool_session: {
      pool_session_id: POOL_SESSION,
      player_id: PLAYER_1,
      state: 'active',
      cluster_epoch: 4,
      entered_at: '2026-10-09T13:10:00.000Z',
      exited_at: null,
      exit_reason: null,
      starting_stack: 400,
      ending_stack: null,
      net_result: 12,
      hands: 31,
      fast_folds: 20,
      normal_folds: 6,
      fold_and_watch: 2,
      showdowns: 3,
      anchor_seat_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      disconnected_at: null,
      stop_requested_at: null,
      auto_rebuys: 0,
      auto_rebuy_total: 0,
      pool_stack: 400,
    },
    trail: [
      {
        at: '2026-10-09T13:10:00.000Z',
        source: 'event',
        kind: 'pool_entered',
        event_id: 9001,
        cluster_epoch: 3,
        payload: { pool_session_id: POOL_SESSION },
      },
      {
        at: '2026-10-09T13:10:01.000Z',
        source: 'slot',
        kind: 'slot_opened',
        slot_id: SLOT,
        slot: 1,
        cluster_epoch: 3,
      },
      {
        at: '2026-10-09T13:57:50.000Z',
        source: 'reservation',
        kind: 'reservation_committed',
        reservation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        instance_id: INSTANCE,
        seat_number: 1,
        reason: null,
        expires_at: '2026-10-09T13:58:05.000Z',
        resolved_at: '2026-10-09T13:58:00.000Z',
      },
      {
        at: '2026-10-09T13:58:00.000Z',
        source: 'hand',
        kind: 'hand',
        hand_id: HAND_ID,
        hand_number: 1042,
        settled_at: '2026-10-09T13:58:40.000Z',
        seat: 1,
        position: 'SB',
        blind_role: 'sb',
        stack_before: 400,
        stack_after: 412,
        net_result: 12,
        fold_type: null,
        waited_ms: 640,
        showed: true,
      },
    ],
    transitions: [
      {
        kind: 'conversion',
        at: '2026-10-09T13:19:40.000Z',
        conversion_id: CONVERSION,
        from_mode: 'must_move',
        to_mode: 'lightning',
        status: 'committed',
        abort_reason: null,
        epoch_before: 3,
        epoch_after: 4,
        opened_at: '2026-10-09T13:19:40.000Z',
        closed_at: '2026-10-09T13:20:00.000Z',
      },
      {
        kind: 'epoch',
        at: '2026-10-09T13:20:00.000Z',
        epoch: 4,
        mode: 'lightning',
        started_by: 'commit_lightning',
        ended_at: null,
      },
    ],
  };
}

export function signalReviewAnswer(status = 'cleared') {
  return {
    ok: true,
    idempotent: false,
    signal_id: 41,
    cluster_id: CLUSTER_A,
    status,
    previous_status: 'open',
    reviewed_by: '12121212-1212-4212-8212-121212121212',
    reviewed_at: AT,
    notes: 'Same household, verified',
  };
}

export const NOT_AUTHORIZED_ANSWER = {
  ok: false,
  code: 'NOT_AUTHORIZED',
  reason: 'NOT_AUTHORIZED',
};
export const NOT_FOUND_ANSWER = { ok: false, code: 'NOT_FOUND', reason: 'NOT_FOUND' };
export const MISSING_FUNCTION_ERROR = {
  code: 'PGRST202',
  message:
    'Could not find the function public.fn_lightning_operator_overview(p_club_id) in the schema cache',
};
