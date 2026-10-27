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
export async function inspect(p) {
  validateSelection(p);
  if (process.env.GIT_COMMIT_SHA !== p.sourceSha) throw Error('serving_identity_changed');
  const moduleAt = (path) => import(pathToFileURL(resolve('dist', path)).href);
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
  const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
  if (!directory) throw Error('journal_unavailable');
  const hands = [];
  let bytes = 0;
  const started = Date.now();
  for (const handKey of p.handKeys) {
    if (Date.now() - started > 30000) throw Error('inspection_bound');
    const records = readHorseJournalHandRecords(directory, handKey);
    bytes += records.reduce((n, r) => n + r.bytes, 0);
    if (bytes > 32 * 1024 * 1024) throw Error('inspection_bound');
    const review = reconcileHorseJournalHand(records, handKey);
    const decisions = [];
    const executions = new Map(
      records.filter((r) => r.kind === 'execution').map((r) => [r.turnKey, JSON.parse(r.body)])
    );
    for (const r of records) {
      if (r.kind !== 'decision' || r.sourceRelease !== p.sourceSha) continue;
      const c = JSON.parse(r.body),
        s = c.snapshot;
      if (
        s?.type !== 'DECIDE_FAST' ||
        !s.gameState?.players?.some((a) => a.user_id === p.opponentId)
      )
        continue;
      const plan = horseRetainedPlanContext(c, s);
      if (plan.kind === 'invalid') throw Error('plan_invalid');
      const context = plan.kind === 'current' ? plan.context : undefined;
      const view = decodeHorseDecisionReads(
        c.readFrame,
        s.gameState.players,
        horsePlanHandKey(s.gameState.actionHistory, context),
        context
      );
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
}
if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  try {
    const p = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8'));
    console.log(JSON.stringify(await inspect(p)));
  } catch {
    console.error('Horse read inspection unavailable or refused');
    process.exitCode = 1;
  }
}
