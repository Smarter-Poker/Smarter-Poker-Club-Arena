/** Bounded read-only journal inspection. Only selected counters and receipts leave the host. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function validateSelection(p) {
  if (
    !p ||
    Object.keys(p).sort().join(',') !== 'handKeys,opponentId,sourceSha' ||
    !uuid.test(p.opponentId) ||
    !/^[a-f0-9]{40}$/.test(p.sourceSha) ||
    !Array.isArray(p.handKeys) ||
    p.handKeys.length < 1 ||
    p.handKeys.length > 16 ||
    new Set(p.handKeys).size !== p.handKeys.length ||
    p.handKeys.some((k) => typeof k !== 'string' || !/^[a-f0-9]{64}$/.test(k))
  )
    throw Error('selection_refused');
  return p;
}
export function summarizeDecision(record, capture, view, opponentId, independent, execution) {
  const s = capture.snapshot;
  if (s?.type !== 'DECIDE_FAST' || !s.gameState?.players?.some((p) => p.user_id === opponentId))
    return null;
  const read = view.stats.get(opponentId);
  const word = (v) => (typeof v === 'string' && /^[a-z0-9_:-]{1,100}$/.test(v) ? v : null);
  const authority = (v) =>
    v ? { mode: word(v.mode), selection: word(v.selection), verdict: word(v.verdict) } : null;
  const o = capture.observerReads;
  return {
    handKey: record.handKey,
    sourceRelease: record.sourceRelease,
    observerId: s.player.user_id,
    decisionTimeMs: s.decisionTimeMs,
    street: s.gameState.stage ?? null,
    action: capture.decision.action,
    independent,
    history: o?.history ?? 'unknown',
    historyHands: o?.historyHands ?? null,
    historyCapped: o?.historyCapped ?? null,
    learnedThroughMs: o?.learnedThroughMs ?? null,
    opponent: read
      ? {
          hands: read.hands,
          vpip: read.vpip,
          pfr: read.pfr,
          threeBet: read.threeBet,
          sourceWindow: read.sourceWindow ?? null,
        }
      : null,
    execution: execution
      ? {
          status: word(execution.executionStatus),
          action: word(execution.executedAction),
          phase11: authority(execution.phase11Authority),
          phase13: authority(execution.phase13Authority),
        }
      : null,
  };
}
const failureReasons = new Set([
  'selection_decode_failed',
  'selection_refused',
  'serving_identity_refused',
  'module_load_failed',
  'journal_configuration_missing',
  'inspection_bound',
  'journal_read_failed',
  'journal_reconciliation_failed',
  'record_decode_failed',
  'retained_plan_refused',
  'read_frame_refused',
  'decision_summary_failed',
  'output_encoding_failed',
]);
const failures = new WeakMap();
function inspectionFailure(reason) {
  const error = new Error();
  failures.set(error, reason);
  return error;
}
// Never classify by a thrown message/code: journal contents and errors are untrusted.
export function sanitizeInspectionFailure(error) {
  const reason = error && typeof error === 'object' ? failures.get(error) : undefined;
  return {
    scope: 'selected_horse_opponent_reads',
    status: 'unavailable',
    reason: failureReasons.has(reason) ? reason : 'inspection_unavailable',
  };
}
export async function inspect(p) {
  let stage = 'selection_refused';
  try {
    validateSelection(p);
    stage = 'serving_identity_refused';
    if (process.env.GIT_COMMIT_SHA !== p.sourceSha) throw Error('serving_identity_changed');
    const moduleAt = (path) => import(pathToFileURL(resolve('dist', path)).href);
    stage = 'module_load_failed';
    const [
      { readHorseJournalHandRecords, reconcileHorseJournalHand, horseRetainedPlanContext },
      { decodeHorseDecisionReads },
      { horsePlanHandKey },
      { horseObserverReadsWereIndependent },
    ] = await Promise.all([
      moduleAt('services/horseDecisionJournal/review.js'),
      moduleAt('engine/HorseDecisionReadFrame.js'),
      moduleAt('engine/HorseDecisionEffects.js'),
      moduleAt('engine/HorseObserverReadEvidence.js'),
    ]);
    stage = 'journal_configuration_missing';
    const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
    if (!directory) throw Error('journal_unavailable');
    const hands = [];
    let bytes = 0;
    const started = Date.now();
    for (const handKey of p.handKeys) {
      stage = 'inspection_bound';
      if (Date.now() - started > 30000) throw Error('inspection_bound');
      stage = 'journal_read_failed';
      const records = readHorseJournalHandRecords(directory, handKey);
      stage = 'inspection_bound';
      bytes += records.reduce((n, r) => n + r.bytes, 0);
      if (bytes > 32 * 1024 * 1024) throw Error('inspection_bound');
      stage = 'journal_reconciliation_failed';
      const review = reconcileHorseJournalHand(records, handKey);
      const decisions = [];
      stage = 'record_decode_failed';
      const executions = new Map(
        records.filter((r) => r.kind === 'execution').map((r) => [r.turnKey, JSON.parse(r.body)])
      );
      for (const r of records) {
        if (r.kind !== 'decision' || r.sourceRelease !== p.sourceSha) continue;
        stage = 'record_decode_failed';
        const c = JSON.parse(r.body),
          s = c.snapshot;
        if (
          s?.type !== 'DECIDE_FAST' ||
          !s.gameState?.players?.some((a) => a.user_id === p.opponentId)
        )
          continue;
        stage = 'retained_plan_refused';
        const plan = horseRetainedPlanContext(c, s);
        if (plan.kind === 'invalid') throw Error('plan_invalid');
        const context = plan.kind === 'current' ? plan.context : undefined;
        stage = 'read_frame_refused';
        const view = decodeHorseDecisionReads(
          c.readFrame,
          s.gameState.players,
          horsePlanHandKey(s.gameState.actionHistory, context),
          context
        );
        stage = 'decision_summary_failed';
        const row = summarizeDecision(
          r,
          c,
          view,
          p.opponentId,
          horseObserverReadsWereIndependent(c.observerReads, s),
          executions.get(r.turnKey)
        );
        if (row) decisions.push(row);
      }
      hands.push({ handKey, review, decisions });
    }
    return {
      scope: 'selected_horse_opponent_reads',
      sourceSha: p.sourceSha,
      opponentId: p.opponentId,
      hands,
      completePopulation: false,
    };
  } catch {
    throw inspectionFailure(stage);
  }
}
if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  let stage = 'selection_decode_failed';
  try {
    const p = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
    stage = 'inspection_unavailable';
    const result = await inspect(p);
    stage = 'output_encoding_failed';
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(
      JSON.stringify(
        sanitizeInspectionFailure(failures.has(error) ? error : inspectionFailure(stage))
      )
    );
    process.exitCode = 1;
  }
}
