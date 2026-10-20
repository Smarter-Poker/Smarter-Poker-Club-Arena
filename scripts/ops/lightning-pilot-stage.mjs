// Lightning pilot stage operator (docs/lightning/ROLLOUT.md Stages 1 and 2).
//
// Every change goes through the one audited door, fn_lightning_operator_control,
// as the authenticated service owner of the private pilot, with a reason and a
// request id derived from the dispatch's operation id, so a retry of the same
// operation replays instead of acting twice. Readiness is read and recorded
// before any enable. It only ever touches the two named private pilot games of
// the Lightning Internal Pilot club; any other Cluster, a public game, a
// no_go verdict or a blocking reason stops activation. Explicit recovery and
// review actions stay available through their existing audited doors.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  LIGHTNING_PILOT_TABLE_SIZE,
  PILOT,
  PILOT_TARGETS,
  pilotServiceFetch,
} from './prepare-lightning-private-pilot.mjs';

export const PILOT_RECOVERY_CONTROLS = Object.freeze([
  'pause',
  'resume',
  'disable_joins',
  'enable_joins',
  'freeze',
  'unfreeze',
  'rollback_matcher_version',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Evidence-level reasons each stage exists to produce (ROLLOUT.md ground rules),
 * read AFTER the stage's own preparation, immediately before its gated action. */
export const STAGE_ACCEPTED_REASONS = Object.freeze({
  shadow: Object.freeze(['NO_AA_CALIBRATION', 'NO_LATENCY_EVIDENCE', 'WORKER_SHADOW_ONLY']),
  form: Object.freeze(['NO_LATENCY_EVIDENCE', 'WORKER_SHADOW_ONLY']),
});

/** Each stage: `prepare` configures (never enables or forms) and runs first on
 * every target; readiness is then read and gated on every target; only then do
 * the `gated` actions run. ROLLOUT.md: readiness is read and recorded "before a
 * Cluster's enable_lightning" - after Stage 1 has switched the worker to shadow,
 * which is itself the evidence WORKER_OFF asks for. Drain retreats ungated. */
export const STAGE_PLAN = Object.freeze({
  shadow: Object.freeze({
    prepare: Object.freeze([
      ['set_flag', { flag: 'lightning_shadow_matcher', value: true }],
      ['set_matcher_version', { version: 'm1-port', role: 'shadow' }],
      ['set_worker_mode', { mode: 'shadow' }],
    ]),
    gated: Object.freeze([['enable_lightning', {}]]),
  }),
  form: Object.freeze({
    prepare: Object.freeze([]),
    gated: Object.freeze([['set_worker_mode', { mode: 'form' }]]),
  }),
  drain: Object.freeze({
    prepare: Object.freeze([['drain', {}]]),
    gated: Object.freeze([]),
    ungated: true,
  }),
  access: Object.freeze({ prepare: Object.freeze([]), gated: Object.freeze([]), ungated: true }),
  off: Object.freeze({
    prepare: Object.freeze([['set_worker_mode', { mode: 'off' }]]),
    gated: Object.freeze([]),
    ungated: true,
  }),
  review: Object.freeze({ prepare: Object.freeze([]), gated: Object.freeze([]), ungated: true }),
  control: Object.freeze({ prepare: Object.freeze([]), gated: Object.freeze([]), ungated: true }),
  report: Object.freeze({ prepare: Object.freeze([]), gated: Object.freeze([]), ungated: true }),
});

/** Every door action of a stage, in execution order (for review and tests). */
export const STAGE_ACTIONS = Object.freeze(
  Object.fromEntries(
    Object.entries(STAGE_PLAN).map(([k, v]) => [k, Object.freeze([...v.prepare, ...v.gated])])
  )
);

/** A stable request id per (operation, cluster, action): a retry replays. */
export function stageRequestId(operationId, clusterId, action) {
  const h = createHash('sha256').update(`${operationId}:${clusterId}:${action}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Readiness gate: ok answer, never no_go, and every reason accepted for the stage. */
export function assertStageReadiness(stage, readiness) {
  if (!readiness || readiness.ok === false || typeof readiness.verdict !== 'string')
    throw new Error('Readiness Unreadable; No Stage Action Taken');
  if (readiness.verdict === 'no_go') throw new Error('Readiness Is No Go; No Stage Action Taken');
  const accepted = STAGE_ACCEPTED_REASONS[stage];
  if (!accepted) return;
  const reasons = Array.isArray(readiness.reasons) ? readiness.reasons : null;
  if (!reasons) throw new Error('Readiness Reasons Unreadable; No Stage Action Taken');
  const blocking = reasons.filter((r) => r?.severity === 'blocking' || !accepted.includes(r?.code));
  if (readiness.verdict !== 'go' && blocking.length > 0)
    throw new Error(
      `Readiness Has Reasons This Stage Does Not Accept: ${blocking.map((r) => r?.code).join(',')}`
    );
}

const ACTION_CLUSTER = '56d5d6f0-23e9-41b0-b407-852aa1026c2a';
const pairing = (playerA, playerB, readTo, counts) =>
  Object.freeze({
    clusterId: ACTION_CLUSTER,
    pattern: 'PAIRING_CONCENTRATION',
    source: 'scan',
    playerA,
    playerB,
    readTo,
    evidence: Object.freeze({
      latest_window_end: '2026-10-19T00:00:00+00:00',
      expectation: 'co_presence',
      hands_in_window: 4412,
      hands_together: counts.together,
      hands_a: counts.a,
      hands_b: counts.b,
      expected_together: counts.expected,
      concentration_ratio: counts.ratio,
    }),
  });

/**
 * Further independently investigated Action findings (2026-10-19). Each is
 * pinned to its exact cluster, pattern, source, pair and retained evidence, and
 * is read back up to `readTo` (just after it was detected) so the operator view's
 * newest-first page of 100 still holds it. Review records `reviewed` with the
 * evidence note; it never deletes evidence, clears a finding or exonerates.
 *
 * PAIRING_CONCENTRATION 12, 14, 38, 41, 49, 69, 77, 110: their expectation
 * ('co_presence') sized the pool from open pool sessions, including busted and
 * unplayable anchors (fixed in migration 20261019174213). Recomputed on the same
 * window (2026-10-18 to 2026-10-19) from who was actually dealt, in ten-minute
 * strata, they measure 0.828, 0.888, 0.950, 1.010, 0.904, 0.982, 0.896 and 1.032
 * against the unchanged 2.0 floor.
 *
 * TIMING_CORRELATION 51 and 141: their original pooled paired-hand moments are
 * reproduced exactly (0.717440 over 23 paired hands in 28 windows; 0.780395 over
 * 34 in 46). All retained paired moments give 0.272259 (51 paired hands, 65
 * windows, through 2026-10-19 10:05Z) and 0.244103 (137 paired hands, 160
 * windows, through 12:21Z).
 */
export const INVESTIGATED_FINDINGS = Object.freeze({
  12: pairing(
    '22f02ebc-4757-4e06-99e6-f7e4a95720b4',
    '84385ab0-d3ea-44c1-8e93-6fa6b1d25457',
    '2026-10-18T00:00:01Z',
    { together: 36, a: 107, b: 187, expected: 7.08, ratio: 5.081 }
  ),
  14: pairing(
    '22f02ebc-4757-4e06-99e6-f7e4a95720b4',
    '24d7c0ff-1b60-453c-8095-836594f30125',
    '2026-10-18T00:00:01Z',
    { together: 43, a: 107, b: 84, expected: 7.27, ratio: 5.914 }
  ),
  38: pairing(
    '06f16138-70cd-49e5-89b3-aec698118b81',
    '24d7c0ff-1b60-453c-8095-836594f30125',
    '2026-10-18T00:00:01Z',
    { together: 42, a: 349, b: 84, expected: 7.16, ratio: 5.87 }
  ),
  41: pairing(
    '06f16138-70cd-49e5-89b3-aec698118b81',
    '22f02ebc-4757-4e06-99e6-f7e4a95720b4',
    '2026-10-18T00:00:01Z',
    { together: 60, a: 349, b: 107, expected: 8.37, ratio: 7.172 }
  ),
  49: pairing(
    '24d7c0ff-1b60-453c-8095-836594f30125',
    '84385ab0-d3ea-44c1-8e93-6fa6b1d25457',
    '2026-10-18T00:00:01Z',
    { together: 35, a: 84, b: 187, expected: 6.53, ratio: 5.36 }
  ),
  69: pairing(
    '1110a1ed-fcf2-423b-9d9a-bc615a16cbd5',
    '82861181-5a96-4e7b-bfa4-b75ca2bd145f',
    '2026-10-19T00:00:01Z',
    { together: 139, a: 723, b: 426, expected: 39.33, ratio: 3.534 }
  ),
  77: pairing(
    '2610f833-88cd-4a55-b255-75b75070b5da',
    '8e5a0e02-7832-416d-970f-f6f74e181dcb',
    '2026-10-19T00:00:01Z',
    { together: 163, a: 815, b: 481, expected: 36.12, ratio: 4.513 }
  ),
  110: pairing(
    '02c8d806-24c7-40bd-b5b5-30cf96811e3e',
    '8e5a0e02-7832-416d-970f-f6f74e181dcb',
    '2026-10-19T00:00:01Z',
    { together: 133, a: 794, b: 481, expected: 37.93, ratio: 3.507 }
  ),
  51: Object.freeze({
    clusterId: ACTION_CLUSTER,
    pattern: 'TIMING_CORRELATION',
    source: 'engine',
    playerA: '6162b471-d011-41f7-ad89-9a8d856c9ffb',
    playerB: 'a23ca5c9-b748-482f-9b59-9db35f7aa996',
    readTo: '2026-10-18T21:44:01Z',
    evidence: Object.freeze({
      latest_window_end: '2026-10-18T21:50:00+00:00',
      correlation_method: 'pooled_paired_hand_moments',
      correlation_hands: 23,
      latency_corr: 0.7174,
      hands_together: 24,
      fast_follows: 1,
      windows: 28,
    }),
  }),
  // Finding 158: original 27 paired hands reproduce r=0.7083577754.
  // The next 113 give r=0.1317385340; all 140 give r=0.1958767140
  // through 2026-10-20T14:31:00Z. Record reviewed, never cleared.
  158: Object.freeze({
    clusterId: ACTION_CLUSTER,
    pattern: 'TIMING_CORRELATION',
    source: 'engine',
    playerA: '05835920-da9b-4739-8fa2-2901b844d11d',
    playerB: '227ba92c-9b8c-4705-ba76-181f1f697638',
    readTo: '2026-10-20T11:07:01Z',
    evidence: Object.freeze({
      latest_window_end: '2026-10-20T11:07:00+00:00',
      correlation_method: 'pooled_paired_hand_moments',
      correlation_hands: 27,
      latency_corr: 0.7084,
      hands_together: 34,
      fast_follows: 3,
      windows: 25,
    }),
  }),
  141: Object.freeze({
    clusterId: ACTION_CLUSTER,
    pattern: 'TIMING_CORRELATION',
    source: 'engine',
    playerA: '0fdb265e-7a56-4ecf-8410-eecd49923e42',
    playerB: '7d1b678f-cea8-41fc-873e-2ec47ea5c318',
    readTo: '2026-10-19T07:40:01Z',
    evidence: Object.freeze({
      latest_window_end: '2026-10-19T08:16:00+00:00',
      correlation_method: 'pooled_paired_hand_moments',
      correlation_hands: 34,
      latency_corr: 0.7804,
      hands_together: 50,
      fast_follows: 3,
      windows: 46,
    }),
  }),
});

/** The investigated finding the readback must match exactly, or null. */
export function investigatedFinding(signalId, clusterId, signal) {
  const f = Object.hasOwn(INVESTIGATED_FINDINGS, signalId) ? INVESTIGATED_FINDINGS[signalId] : null;
  if (
    !f ||
    clusterId !== f.clusterId ||
    signal?.pattern_type !== f.pattern ||
    signal?.source !== f.source ||
    signal?.player_a !== f.playerA ||
    signal?.player_b !== f.playerB
  )
    return null;
  for (const [k, v] of Object.entries(f.evidence)) if (signal.evidence?.[k] !== v) return null;
  return f;
}

/** The game must be one of the named private pilot targets in the pilot club. */
export function assertStageTarget(game, clubId) {
  const target = PILOT_TARGETS.find((t) => t.gameName === game?.name);
  if (
    !target ||
    !UUID.test(game?.id ?? '') ||
    game.club_id !== clubId ||
    game.template_name !== target.templateName ||
    game.variant !== 'nlh' ||
    game.handedness !== LIGHTNING_PILOT_TABLE_SIZE ||
    game.handedness !== target.handedness ||
    Number(game.sb) !== target.sb ||
    Number(game.bb) !== target.bb ||
    game.must_move !== true ||
    game.ruleset_snapshot?.options?.is_private !== true ||
    game.closed_at
  )
    throw new Error('Stage Target Is Not A Private Pilot Game');
  return target;
}

export async function runPilotStage(env = process.env, clientFactory, accessRunner) {
  const stage = env.PILOT_STAGE;
  const consentInput = env.PILOT_ACCEPT_OUTSIDER_TERMS ?? 'false';
  if (!['true', 'false'].includes(consentInput) || (consentInput === 'true' && stage !== 'access'))
    throw new Error('Outsider Terms Acceptance Requires An Explicit Access Stage');
  if (!Object.hasOwn(STAGE_ACTIONS, stage)) throw new Error('Unknown Pilot Stage');
  const controlAction = env.PILOT_CONTROL_ACTION ?? '';
  if (stage === 'control' && !PILOT_RECOVERY_CONTROLS.includes(controlAction))
    throw new Error('An Explicit Supported Pilot Recovery Control Is Required');
  const operationId = env.PILOT_OPERATION_ID ?? '';
  if (stage !== 'report' && !UUID.test(operationId))
    throw new Error('A Stage Action Requires An Operation UUID');
  const reason = (env.PILOT_REASON ?? '').trim();
  if (stage === 'review' && reason.length > 1800)
    throw new Error('Review Note Exceeds Its Recorded Bound');
  if (stage !== 'report' && reason.length < 12) throw new Error('A Stage Action Requires A Reason');
  if (
    env.SP_EMAIL?.toLowerCase() !== PILOT.ownerEmail ||
    !env.SP_PASS ||
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  )
    throw new Error('Configured Verified Service Credentials Are Required');
  const createClient = clientFactory ?? (await import('@supabase/supabase-js')).createClient;
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    ...options,
    global: { fetch: pilotServiceFetch(env.SUPABASE_SERVICE_ROLE_KEY) },
  });
  const player = createClient(
    env.SUPABASE_URL,
    'sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx',
    options
  );
  const must = (result, label) => {
    if (result.error) throw new Error(`${label}: ${result.error.code || 'Request Failed'}`);
    return result.data;
  };
  // Targets are named by template. Both are six-seat since 2026-10-17, and
  // every Lightning game is six-seat by the owner's 2026-10-19 ruling, so a
  // seat count no longer names one; the old 6 and 9 inputs are only aliases
  // for Action and Madness so an earlier dispatch reads the same six-seat
  // targets. No input ever selects a nine-seat game (assertStageTarget).
  const LEGACY_SIZES = { 6: 'action', 9: 'madness' };
  const wanted = [
    ...new Set(
      (env.PILOT_TARGETS ?? 'action,madness')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .map((s) => LEGACY_SIZES[s] ?? s)
        .filter((s) => s === 'action' || s === 'madness')
    ),
  ];
  if (wanted.length === 0) throw new Error('No Pilot Target Selected');
  const signalId = Number(env.PILOT_SIGNAL_ID);
  if (
    stage === 'review' &&
    (wanted.length !== 1 ||
      !Number.isSafeInteger(signalId) ||
      !(
        (signalId >= 1 && signalId <= 8) ||
        signalId === 50 ||
        Object.hasOwn(INVESTIGATED_FINDINGS, signalId)
      ))
  )
    throw new Error('Review Requires One Target And One Investigated Pilot Finding');
  const report = {
    stage,
    operationId: operationId || null,
    startedAt: new Date().toISOString(),
    clusters: [],
  };
  let primaryError;
  try {
    const login = must(
      await player.auth.signInWithPassword({ email: env.SP_EMAIL, password: env.SP_PASS }),
      'Service Login'
    );
    if (login.user?.id !== PILOT.ownerId)
      throw new Error('Authenticated Service Identity Mismatch');
    const club = must(
      await admin
        .from('clubs')
        .select('id,owner_id,name,is_public')
        .eq('owner_id', PILOT.ownerId)
        .eq('name', PILOT.name)
        .maybeSingle(),
      'Pilot Club'
    );
    if (!club?.id || club.is_public !== false) throw new Error('Pilot Club Missing Or Public');
    const games = must(
      await admin.from('cash_games').select('*').eq('club_id', club.id),
      'Pilot Games'
    );
    // Resolve EVERY selected target before the first action, so a missing
    // game never leaves one size half-staged.
    const staged = [];
    for (const template of wanted) {
      const target = PILOT_TARGETS.find((t) => t.templateName === template);
      const matches = (Array.isArray(games) ? games : []).filter((g) => g.name === target.gameName);
      if (matches.length !== 1) throw new Error(`Pilot ${target.gameName} Game Not Uniquely Found`);
      const game = matches[0];
      assertStageTarget(game, club.id);
      const entry = {
        template,
        handedness: target.handedness,
        clusterId: game.id,
        actions: [],
      };
      report.clusters.push(entry);
      staged.push({ game, entry });
    }
    if (stage === 'access') {
      const run = accessRunner ?? (await import('./lightning-pilot-access.mjs')).runPilotAccess;
      const chromium = accessRunner ? null : (await import('@playwright/test')).chromium;
      const WebSocket = accessRunner ? null : (await import('ws')).default;
      try {
        report.access = await run({
          admin,
          player,
          createClient,
          url: env.SUPABASE_URL,
          games: staged.map((s) => s.game),
          operationId,
          requestId: stageRequestId(operationId, club.id, 'pending_access_proof'),
          chromium,
          WebSocket,
          acceptOutsiderTerms: consentInput === 'true',
        });
      } catch (error) {
        report.access = error.pilotAccessReport ?? { verdict: 'unknown' };
        throw error;
      }
    }
    // A review is an explicit operator judgment on one investigated finding,
    // never a bulk clear or launch certificate. Preserve the original evidence.
    if (stage === 'review') {
      const { game, entry } = staged[0];
      const detail = must(
        await player.rpc('fn_lightning_operator_cluster', {
          p_cluster_id: game.id,
          p_from: '2026-10-15T20:00:00Z',
          // The view pages the newest 100 findings; an investigated finding is
          // read up to just after its own detection so it stays on that page.
          p_to: INVESTIGATED_FINDINGS[signalId]?.readTo ?? new Date().toISOString(),
        }),
        'Signal Evidence'
      );
      const note = `${reason} [operation ${operationId}]`;
      const matches = Array.isArray(detail?.integrity_signals)
        ? detail.integrity_signals.filter((s) => Number(s.id) === signalId)
        : [];
      const signal = matches[0];
      // Finding 8 is a separate, measured timing review, not one of the
      // legacy short-sample findings. Preserve its exact evidence and live
      // workload; this door only records reviewed, never cleared/actioned.
      const measured =
        signalId === 8 &&
        game.id === '56d5d6f0-23e9-41b0-b407-852aa1026c2a' &&
        signal?.player_a === '07db1c71-d567-46dd-8f92-e922b6d470ae' &&
        signal?.player_b === '285055c6-96a7-4a60-9033-51f83f49dbcb' &&
        signal?.evidence?.latest_window_end === '2026-10-17T19:27:00+00:00' &&
        signal.evidence.correlation_method === 'pooled_paired_hand_moments' &&
        signal.evidence.correlation_hands === 32 &&
        signal.evidence.latency_corr === 0.7681 &&
        signal.evidence.hands_together === 39 &&
        signal.evidence.fast_follows === 6;
      const legacy =
        signalId <= 7 &&
        game.cluster_mode === 'must_move' &&
        game.lightning_enabled === false &&
        Number.isFinite(Date.parse(signal?.evidence?.latest_window_end)) &&
        Date.parse(signal.evidence.latest_window_end) <= Date.parse('2026-10-15T20:55:08.098Z') &&
        signal.evidence.correlation_method == null;
      // Independently recomputed: the original 25 paired moments give .733988;
      // all 28 retained paired moments give .202620. Preserve the original
      // high finding and evidence. This records reviewed, never exonerated.
      const madnessMeasured =
        signalId === 50 &&
        game.id === '681eb9e8-e9fd-4026-8ec6-64075b911d33' &&
        signal?.player_a === '194e5206-bd4d-4ea5-ba2d-142c8bf8a258' &&
        signal?.player_b === '4ffcc7ec-15a1-4c80-8309-e893ef9db022' &&
        signal?.evidence?.latest_window_end === '2026-10-18T22:02:00+00:00' &&
        signal.evidence.correlation_method === 'pooled_paired_hand_moments' &&
        signal.evidence.correlation_hands === 25 &&
        signal.evidence.latency_corr === 0.734 &&
        signal.evidence.hands_together === 45 &&
        signal.evidence.fast_follows === 1 &&
        signal.evidence.windows === 44;
      const investigated = investigatedFinding(signalId, game.id, signal);
      if (
        !(measured || madnessMeasured || legacy || investigated) ||
        detail?.ok !== true ||
        detail.cluster_id !== game.id ||
        matches.length !== 1 ||
        signal.pattern_type !== (investigated?.pattern ?? 'TIMING_CORRELATION') ||
        signal.source !== (investigated?.source ?? 'engine') ||
        signal.severity !== 'high' ||
        !['open', 'reviewed'].includes(signal.status) ||
        (signal.status === 'reviewed' && signal.notes !== note)
      )
        throw new Error(
          'Investigated Signal Evidence Missing, Changed Or Already Reviewed By Another Operation'
        );
      entry.signalBefore = signal;
      const answer = must(
        await player.rpc('fn_lightning_operator_signal_review', {
          p_signal_id: signalId,
          p_status: 'reviewed',
          p_note: note,
        }),
        'Signal Review'
      );
      entry.actions.push({ action: 'signal_review', signalId, answer });
      if (
        answer?.ok !== true ||
        Number(answer.signal_id) !== signalId ||
        answer.status !== 'reviewed'
      )
        throw new Error('Signal Review Refused Or Unreadable; Recover This Same Operation');
    }
    const act = async (game, entry, action, args) => {
      const requestId = stageRequestId(operationId, game.id, action);
      const answer = must(
        await player.rpc('fn_lightning_operator_control', {
          p_cluster_id: game.id,
          p_action: action,
          p_reason: reason,
          p_args: { ...args, request_id: requestId },
        }),
        `Control ${action}`
      );
      entry.actions.push({ action, requestId, answer });
      if (answer?.code === 'REQUEST_IN_PROGRESS')
        throw new Error(`${action} Still In Progress; Retry The Same Operation ID`);
      if (answer?.ok !== true) throw new Error(`${action} Refused: ${answer?.code ?? 'UNKNOWN'}`);
    };
    // Recovery controls do not enable Lightning or form hands. Like drain,
    // they remain available when readiness is no_go. One action per dispatch
    // preserves the original request on a partial result; never auto-restore
    // an earlier state after an unknown or refused answer.
    const plan =
      stage === 'control'
        ? { prepare: [], gated: [[controlAction, {}]], ungated: true }
        : STAGE_PLAN[stage];
    for (const { game, entry } of staged)
      for (const [action, args] of plan.prepare) await act(game, entry, action, args);
    // Readiness, read and recorded on every target, gates the stage's gated actions.
    for (const { game, entry } of staged) {
      entry.readinessBefore = must(
        await player.rpc('fn_lightning_rollout_readiness', { p_cluster_id: game.id }),
        'Readiness'
      );
      if (!plan.ungated) assertStageReadiness(stage, entry.readinessBefore);
    }
    for (const { game, entry } of staged)
      for (const [action, args] of plan.gated) await act(game, entry, action, args);
    for (const { game, entry } of staged) {
      entry.shadowReport = must(
        await admin.rpc('fn_lightning_shadow_report', { p_cluster_id: game.id }),
        'Shadow Report'
      );
      entry.readinessAfter = must(
        await player.rpc('fn_lightning_rollout_readiness', { p_cluster_id: game.id }),
        'Readiness After'
      );
    }
  } catch (error) {
    primaryError = error;
    report.error = String(error?.message ?? error);
  } finally {
    const out = await player.auth.signOut({ scope: 'local' }).catch((e) => ({ error: e }));
    report.serviceSessionCleanup = out?.error ? 'unverified' : 'local_signout_confirmed';
    if (out?.error && !primaryError) primaryError = new Error('Service Session Cleanup Failed');
    report.completedAt = new Date().toISOString();
    if (env.PILOT_STAGE_REPORT_PATH)
      writeFileSync(env.PILOT_STAGE_REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
  }
  if (primaryError) throw primaryError;
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runPilotStage().then(
    (r) =>
      console.log(
        JSON.stringify({
          stage: r.stage,
          clusters: r.clusters.map((c) => ({
            template: c.template,
            handedness: c.handedness,
            clusterId: c.clusterId,
            actions: c.actions.map((a) => [a.action, a.answer?.ok]),
          })),
        })
      ),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exitCode = 1;
    }
  );
}
