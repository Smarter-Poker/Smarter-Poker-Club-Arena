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
import { PILOT, PILOT_TARGETS, pilotServiceFetch } from './prepare-lightning-private-pilot.mjs';

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

/** The game must be one of the named private pilot targets in the pilot club. */
export function assertStageTarget(game, clubId) {
  const target = PILOT_TARGETS.find((t) => t.gameName === game?.name);
  if (
    !target ||
    !UUID.test(game?.id ?? '') ||
    game.club_id !== clubId ||
    game.template_name !== target.templateName ||
    game.variant !== 'nlh' ||
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
  const wanted = (env.PILOT_TARGETS ?? '6,9')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => n === 6 || n === 9);
  if (wanted.length === 0) throw new Error('No Pilot Target Selected');
  const signalId = Number(env.PILOT_SIGNAL_ID);
  if (
    stage === 'review' &&
    (wanted.length !== 1 || !Number.isSafeInteger(signalId) || signalId < 1 || signalId > 7)
  )
    throw new Error('Review Requires One Target And One Of The Seven Investigated Pilot Findings');
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
    for (const handedness of wanted) {
      const target = PILOT_TARGETS.find((t) => t.handedness === handedness);
      const matches = (Array.isArray(games) ? games : []).filter((g) => g.name === target.gameName);
      if (matches.length !== 1) throw new Error(`Pilot ${handedness}-Max Game Not Uniquely Found`);
      const game = matches[0];
      assertStageTarget(game, club.id);
      const entry = { handedness, clusterId: game.id, actions: [] };
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
          p_to: new Date().toISOString(),
        }),
        'Signal Evidence'
      );
      const note = `${reason} [operation ${operationId}]`;
      const matches = Array.isArray(detail?.integrity_signals)
        ? detail.integrity_signals.filter((s) => Number(s.id) === signalId)
        : [];
      const signal = matches[0];
      if (
        game.cluster_mode !== 'must_move' ||
        game.lightning_enabled !== false ||
        !Number.isFinite(Date.parse(signal?.evidence?.latest_window_end)) ||
        Date.parse(signal.evidence.latest_window_end) > Date.parse('2026-10-15T20:55:08.098Z') ||
        signal.evidence.correlation_method != null ||
        detail?.ok !== true ||
        detail.cluster_id !== game.id ||
        matches.length !== 1 ||
        signal.pattern_type !== 'TIMING_CORRELATION' ||
        signal.source !== 'engine' ||
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
