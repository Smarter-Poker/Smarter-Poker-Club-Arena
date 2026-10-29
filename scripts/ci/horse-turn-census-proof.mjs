/** Finite original-record census. No policy execution, raw export or universal certificate. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
const hash = (x) => createHash('sha256').update(x).digest('hex');
export function horseTurnCensusPacketDigest(packet) {
  const sorted = (v) =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sorted(v[k])])
          )
        : v;
  return hash(JSON.stringify(sorted(packet)));
}
const hex = (x, n) => typeof x === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(x);
const exact = (x, keys) =>
  x !== null &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  Object.keys(x).length === keys.length &&
  keys.every((k) => Object.hasOwn(x, k));
const variants = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8', 'pineapple', 'short_deck', 'flh', 'flo8'];
const validContext = (c) =>
  exact(c, ['variant', 'format', 'provenance']) &&
  variants.includes(c.variant) &&
  ['cash', 'tournament'].includes(c.format) &&
  ['committed_hand_history', 'retained_submission_and_committed_history'].includes(c.provenance);
export function horseTurnContextBinding(context, snapshot) {
  if (
    !validContext(context) ||
    !snapshot?.gameState ||
    !variants.includes(snapshot.gameState.gameVariant) ||
    !['cash', 'tournament'].includes(snapshot.gameState.gameMode)
  )
    return 'unknown';
  return context.variant === snapshot.gameState.gameVariant &&
    context.format === snapshot.gameState.gameMode
    ? 'matched'
    : 'contradictory';
}
const historyReasons = {
  pending: ['loading', 'load_capacity'],
  available: ['packet_ready', 'worker_acknowledged', 'packet_after_cutoff'],
  unavailable: [
    'provider_error',
    'provider_empty_response',
    'provider_source_mismatch',
    'provider_invalid_window',
    'provider_deadline',
    'provider_thrown',
    'cache_disposed',
    'retry_load_capacity',
    'retention_invalid_claim',
    'retention_heap_unavailable',
    'retention_heap_headroom',
    'retention_capacity',
    'invalid_window',
    'context_mismatch',
    'packet_size_refused',
    'load_rejected',
    'load_thrown',
  ],
};
export function horseTurnHistoryReason(snapshot, api) {
  try {
    const p = snapshot?.ownPublicHistoryProvenance;
    if (
      !exact(p, ['version', 'context', 'decisionTimeMs', 'state', 'reason']) ||
      p.version !== 1 ||
      !Number.isSafeInteger(p.decisionTimeMs) ||
      p.decisionTimeMs < 0 ||
      p.decisionTimeMs !== snapshot.decisionTimeMs ||
      p.state !== snapshot.ownPublicHistoryState ||
      !historyReasons[p.state]?.includes(p.reason)
    )
      return 'unknown';
    const context = api.horseObserverReadContextFromRequest(snapshot);
    const key = api.horseObserverReadContextKey(context);
    if (
      !key ||
      api.horseObserverReadContextKey(p.context) !== key ||
      (p.reason === 'packet_ready'
        ? snapshot.ownPublicHistory === undefined
        : snapshot.ownPublicHistory !== undefined)
    )
      return 'unknown';
    return p.reason;
  } catch {
    return 'unknown';
  }
}
const stages = ['preflop', 'flop', 'pineapple_discard', 'turn', 'river', 'showdown'];
const actions = ['fold', 'check', 'call', 'bet', 'raise', 'all_in', 'discard'];
const origins = ['player', 'pre_action', 'horse_policy', 'horse_fallback', 'forced', 'unknown'];
export const HORSE_TURN_CENSUS_LIMITS = Object.freeze({
  hands: 64,
  turns: 1024,
  recordsPerHand: 256,
  bytesPerHand: 8 * 1024 * 1024,
  validatedBytes: 64 * 1024 * 1024,
  elapsedMs: 30000,
});
const utc = (x) =>
  typeof x === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) &&
  Number.isFinite(Date.parse(x)) &&
  new Date(x).toISOString() === x;
export function validateHorseTurnCensusPacket(p, expectedSource = p?.sourceSha) {
  if (
    !exact(p, ['version', 'sourceSha', 'window', 'horseIds', 'hands']) ||
    ![2, 3].includes(p.version) ||
    !hex(expectedSource, 40) ||
    p.sourceSha !== expectedSource ||
    !exact(p.window, ['startUtc', 'endUtc']) ||
    !utc(p.window.startUtc) ||
    !utc(p.window.endUtc)
  )
    throw Error('invalid_packet');
  const start = Date.parse(p.window.startUtc),
    end = Date.parse(p.window.endUtc);
  if (
    end <= start ||
    end - start > 86400000 ||
    !Array.isArray(p.horseIds) ||
    p.horseIds.length !== 1000 ||
    p.horseIds.some(
      (id, i) =>
        typeof id !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) ||
        (i > 0 && p.horseIds[i - 1] >= id)
    ) ||
    !Array.isArray(p.hands) ||
    !p.hands.length ||
    p.hands.length > HORSE_TURN_CENSUS_LIMITS.hands
  )
    throw Error('invalid_packet');
  let turns = 0;
  const seen = new Set();
  for (const h of p.hands) {
    if (
      !exact(h, ['handKey', 'committedAtMs', 'actions', ...(p.version === 3 ? ['context'] : [])]) ||
      (p.version === 3 && !validContext(h.context)) ||
      !hex(h.handKey, 64) ||
      seen.has(h.handKey) ||
      !Number.isSafeInteger(h.committedAtMs) ||
      h.committedAtMs < start ||
      h.committedAtMs >= end ||
      !Array.isArray(h.actions) ||
      h.actions.length > 4096
    )
      throw Error('invalid_hand_domain');
    seen.add(h.handKey);
    let prior = -1;
    for (const a of h.actions) {
      if (
        !exact(a, [
          'actorIndex',
          'actionOrdinal',
          'stage',
          'action',
          'origin',
          'amount',
          'seat',
          'timestamp',
        ]) ||
        !Number.isSafeInteger(a.actorIndex) ||
        a.actorIndex < 0 ||
        a.actorIndex >= 1000 ||
        !Number.isSafeInteger(a.actionOrdinal) ||
        a.actionOrdinal <= prior ||
        a.actionOrdinal >= 4096 ||
        !stages.includes(a.stage) ||
        !actions.includes(a.action) ||
        !origins.includes(a.origin) ||
        !(a.amount === null || (Number.isFinite(a.amount) && a.amount >= 0)) ||
        !(a.seat === null || (Number.isSafeInteger(a.seat) && a.seat >= 1 && a.seat <= 10)) ||
        !(a.timestamp === null || (Number.isSafeInteger(a.timestamp) && a.timestamp >= 0))
      )
        throw Error('invalid_turn_domain');
      prior = a.actionOrdinal;
    }
    turns += h.actions.length;
    if (turns > HORSE_TURN_CENSUS_LIMITS.turns) throw Error('turn_bound');
  }
  if (Buffer.byteLength(JSON.stringify(p)) > HORSE_TURN_CENSUS_LIMITS.validatedBytes)
    throw Error('packet_bound');
  return p;
}
const unknownPhase = () =>
  Object.fromEntries(
    Array.from({ length: 15 }, (_, i) => [
      `phase${i + 1}`,
      {
        status: 'unknown',
        capability: 'unobserved',
        eligibility: 'unknown',
        qualification: 'unknown',
        application: 'unknown',
        reasonSha256: null,
      },
    ])
  );
function closedPhases(value) {
  const out = unknownPhase();
  for (const key of Object.keys(out)) {
    const p = value?.[key];
    if (
      !p ||
      !['captured', 'unobserved'].includes(p.capability) ||
      !['verified', 'owner-forced', 'unknown', 'refused'].includes(p.qualification) ||
      ![
        'unknown',
        'outside-domain',
        'refused',
        'applicable-active',
        'shadow',
        'unobserved',
      ].includes(p.status) ||
      !['unknown', 'outside-domain', 'eligible'].includes(p.eligibility) ||
      !['unknown', 'not-applicable', 'accepted', 'refused', 'not-selected', 'shadow'].includes(
        p.application
      ) ||
      typeof p.reason !== 'string' ||
      p.reason.length > 256
    )
      continue;
    out[key] = {
      status: p.status,
      capability: p.capability,
      eligibility: p.eligibility,
      qualification: p.qualification,
      application: p.application,
      reasonSha256: hash(p.reason),
    };
  }
  return out;
}
const emptyTurn = (h, a) => ({
  ...(h.context ? { contextBinding: 'unknown', historyReason: 'unknown' } : {}),
  actorIndex: a.actorIndex,
  handKey: h.handKey,
  actionOrdinal: a.actionOrdinal,
  stage: a.stage,
  action: a.action,
  origin: a.origin,
  expectedBinding: 'unknown',
  capture: 'missing',
  execution: 'missing',
  selection: 'unknown',
  inputBinding: 'unknown',
  publicRead: 'unknown',
  historicalRead: 'unknown',
  handReconciliation: 'unknown',
  phases: unknownPhase(),
});
const equalAction = (a, expected, ids) =>
  !!a &&
  ids[expected.actorIndex] === a.userId &&
  expected.stage === a.stage &&
  expected.action === a.action &&
  expected.origin === (a.origin ?? 'unknown') &&
  expected.amount === (a.amount ?? null) &&
  expected.seat === (a.seat ?? null) &&
  expected.timestamp === (a.timestamp ?? null);
/** Batch is a private installed-store result. Only closed fields are returned. Missing domains survive every refusal. */
export function inspectHorseTurnCensus(packet, batch, api, clock = () => performance.now()) {
  const base = {
    version: packet?.version === 3 ? 3 : 2,
    scope: 'supplied_committed_turn_census',
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    completePopulation: false,
    strategyCorrectnessVerified: false,
    activationAllowed: false,
  };
  try {
    validateHorseTurnCensusPacket(packet);
  } catch {
    return { ...base, reason: 'input_refused', turns: [] };
  }
  const turns = packet.hands.flatMap((h) => h.actions.map((a) => emptyTurn(h, a)));
  const result = {
    ...base,
    sourceSha: packet.sourceSha,
    packetDigest: horseTurnCensusPacketDigest(packet),
    expectedTurns: turns.length,
    validatedBytes: 0,
    boundReached: false,
    missingTurns: turns.length,
    contradictoryTurns: 0,
    extraneousCaptures: 0,
    unboundCaptures: 0,
    inspectedHands: 0,
    remainingHands: packet.hands.length,
    turns,
  };
  if (
    !exact(batch, [
      'sourceRelease',
      'recordsByHand',
      ...(Object.hasOwn(batch ?? {}, 'readBudget') ? ['readBudget'] : []),
    ]) ||
    batch.sourceRelease !== packet.sourceSha ||
    !Array.isArray(batch.recordsByHand) ||
    batch.recordsByHand.length !== packet.hands.length
  )
    return { ...result, reason: 'batch_refused' };
  const readBudget = batch.readBudget;
  if (
    readBudget &&
    (!exact(readBudget, ['validatedBytes', 'elapsedMs', 'boundReached']) ||
      !Number.isSafeInteger(readBudget.validatedBytes) ||
      readBudget.validatedBytes < 0 ||
      !Number.isFinite(readBudget.elapsedMs) ||
      readBudget.elapsedMs < 0 ||
      typeof readBudget.boundReached !== 'boolean')
  )
    return { ...result, reason: 'batch_refused' };
  const started = clock() - (readBudget?.elapsedMs ?? 0);
  result.validatedBytes = readBudget?.validatedBytes ?? 0;
  result.boundReached = readBudget?.boundReached ?? false;
  const budget = () => {
    if (
      result.boundReached ||
      clock() - started >= HORSE_TURN_CENSUS_LIMITS.elapsedMs ||
      result.validatedBytes > HORSE_TURN_CENSUS_LIMITS.validatedBytes
    ) {
      result.boundReached = true;
      throw Error('bound_reached');
    }
  };
  let interpreter;
  try {
    interpreter = new api.HorseFleetPhaseInterpreter(budget);
  } catch {
    return { ...result, reason: 'installed_api_unavailable' };
  }
  let offset = 0;
  for (let i = 0; i < packet.hands.length; i++) {
    const expected = packet.hands[i],
      rows = turns.slice(offset, offset + expected.actions.length);
    offset += expected.actions.length;
    try {
      budget();
      const entry = batch.recordsByHand[i];
      if (
        !exact(entry, ['handKey', 'records']) ||
        entry.handKey !== expected.handKey ||
        !Array.isArray(entry.records) ||
        entry.records.length > 256
      )
        throw Error('hand_refused');
      const records = [],
        seen = new Map();
      let bytes = 0;
      for (const r of entry.records) {
        budget();
        api.validateHorseJournalRecord(r);
        const encoded = api.horseJournalJson(r),
          size = Buffer.byteLength(encoded);
        if (!readBudget) result.validatedBytes += size;
        bytes += size;
        budget();
        if (
          bytes > HORSE_TURN_CENSUS_LIMITS.bytesPerHand ||
          r.handKey !== expected.handKey ||
          r.sourceRelease !== packet.sourceSha
        )
          throw Error('record_refused');
        if (seen.has(r.eventId)) {
          if (seen.get(r.eventId) !== encoded) throw Error('record_conflict');
          continue;
        }
        seen.set(r.eventId, encoded);
        records.push(r);
      }
      result.inspectedHands++;
      result.remainingHands--;
      const accepted = records.filter((r) => r.kind === 'accepted_hand');
      if (accepted.length !== 1) continue;
      const hand = JSON.parse(accepted[0].body);
      if (
        accepted[0].turnKey !== expected.handKey ||
        hash(api.horseCompletedHandKey(hand)) !== expected.handKey ||
        !Array.isArray(hand.actions) ||
        hand.actions.length > 4096
      )
        throw Error('accepted_hand_refused');
      // Compare the entire supplied actor domain, not just rows with a retained decision.
      const actualDomain = hand.actions.flatMap((a, n) =>
        packet.horseIds.includes(a.userId) && actions.includes(a.action) ? [n] : []
      );
      const expectedDomain = expected.actions.map((a) => a.actionOrdinal);
      const domainMatches =
        JSON.stringify(actualDomain) === JSON.stringify(expectedDomain) &&
        !hand.actions.some(
          (a) =>
            ['horse_policy', 'horse_fallback'].includes(a.origin) &&
            !packet.horseIds.includes(a.userId)
        );
      const review = api.reconcileHorseJournalHand(records, expected.handKey);
      const reconciled =
        review.status === 'reconciled' && Array.isArray(review.gaps) && review.gaps.length === 0;
      for (let n = 0; n < rows.length; n++) {
        rows[n].expectedBinding =
          domainMatches &&
          equalAction(
            hand.actions[expected.actions[n].actionOrdinal],
            expected.actions[n],
            packet.horseIds
          )
            ? 'matched'
            : 'contradictory';
        rows[n].handReconciliation = reconciled ? 'reconciled' : 'incomplete';
        if (rows[n].expectedBinding === 'matched' && rows[n].origin === 'forced') {
          // A forced accepted action supplies no strategy/read consumption evidence.
          rows[n].publicRead = 'not_applicable';
          rows[n].historicalRead = 'not_applicable';
          rows[n].phases = Object.fromEntries(
            Object.keys(unknownPhase()).map((key) => [
              key,
              {
                status: 'outside-domain',
                capability: 'unobserved',
                eligibility: 'outside-domain',
                qualification: 'unknown',
                application: 'not-applicable',
                reasonSha256: hash('forced_action_has_no_strategy_consumption_claim'),
              },
            ])
          );
        }
      }
      const candidates = new Map();
      for (const r of records.filter((r) => r.kind === 'decision')) {
        budget();
        const c = JSON.parse(r.body),
          executions = records.filter(
            (e) =>
              e.kind === 'execution' && e.producerId === r.producerId && e.turnKey === r.turnKey
          );
        if (executions.length !== 1) {
          result.unboundCaptures++;
          continue;
        }
        const e = executions[0],
          w = JSON.parse(e.body),
          binding = api.bindHorseDecisionToCommittedHand(w, hand);
        if (binding.status !== 'bound' || r.sequence >= e.sequence) {
          result.unboundCaptures++;
          continue;
        }
        const n = expectedDomain.indexOf(binding.actionOrdinal);
        if (n < 0) {
          result.extraneousCaptures++;
          continue;
        }
        if (!candidates.has(n)) candidates.set(n, []);
        candidates.get(n).push({ r, c, e, w });
      }
      // Physical discard choices have their own private request/controller codec.
      // Never synthesize a betting snapshot/read frame from those card-bearing requests.
      for (const r of records.filter((r) => r.kind === 'discard_decision')) {
        budget();
        try {
          const c = JSON.parse(r.body);
          api.validateHorseDiscardDecision(c);
          const executions = records.filter(
            (e) =>
              e.kind === 'discard_execution' &&
              e.producerId === r.producerId &&
              e.turnKey === r.turnKey
          );
          if (executions.length !== 1) {
            result.unboundCaptures++;
            continue;
          }
          const e = executions[0],
            w = JSON.parse(e.body);
          api.validateHorseDiscardExecution(w);
          if (
            r.sequence >= e.sequence ||
            api.horseJournalJson(c.snapshot) !== api.horseJournalJson(w.request) ||
            c.cardIndex !== w.selectedIndex ||
            hash(api.horseDiscardTurnKey(c.snapshot)) !== r.turnKey ||
            hash(api.horseDiscardTurnKey(w.request)) !== e.turnKey ||
            hash(api.horseDiscardHandKey(c.snapshot)) !== expected.handKey
          ) {
            result.unboundCaptures++;
            continue;
          }
          const ordinal = api.bindHorseDiscardExecutionToHand(w, hand);
          if (ordinal === null) {
            result.unboundCaptures++;
            continue;
          }
          const n = expectedDomain.indexOf(ordinal);
          if (n < 0) {
            result.extraneousCaptures++;
            continue;
          }
          if (!candidates.has(n)) candidates.set(n, []);
          candidates.get(n).push({ r, c, e, w, discard: true });
        } catch {
          result.unboundCaptures++;
        }
      }
      for (const [n, matches] of candidates) {
        const out = rows[n];
        out.capture = matches.length === 1 ? 'present' : 'ambiguous';
        if (matches.length !== 1) {
          out.execution = 'ambiguous';
          continue;
        }
        const { r, c, w, discard } = matches[0],
          s = c.snapshot;
        if (discard) {
          out.execution = 'intended';
          out.selection = 'matched';
          if (
            !reconciled ||
            out.expectedBinding !== 'matched' ||
            out.action !== 'discard' ||
            c.snapshot.journalContext?.actorId !== packet.horseIds[out.actorIndex]
          )
            continue;
          out.inputBinding = 'original_discard_request_and_controller';
          out.publicRead = 'not_applicable';
          out.historicalRead = 'not_applicable';
          out.phases = Object.fromEntries(
            Object.keys(unknownPhase()).map((key) => [
              key,
              {
                status: 'outside-domain',
                capability: 'captured',
                eligibility: 'outside-domain',
                qualification: 'unknown',
                application: 'not-applicable',
                reasonSha256: hash('physical_discard_request_outside_betting_phase_domain'),
              },
            ])
          );
          continue;
        }
        out.execution = ['intended', 'coerced', 'retired'].includes(w.executionStatus)
          ? w.executionStatus
          : 'unknown';
        const zero = w.executedAction === 'fold' || w.executedAction === 'check';
        out.selection =
          w.executionStatus === 'intended' &&
          w.executedAction === w.selected?.action &&
          w.selected?.action === c.decision?.action &&
          (zero
            ? w.executedAmount === null &&
              w.expectedExecutionAmount === 0 &&
              w.acceptedActions?.[0]?.record?.amount === 0
            : w.executedAmount === w.expectedExecutionAmount)
            ? 'matched'
            : 'unknown';
        if (!reconciled || out.expectedBinding !== 'matched') continue;
        const plan = api.horseRetainedPlanContext(c, s);
        if (
          plan.kind === 'invalid' ||
          s?.player?.user_id !== packet.horseIds[out.actorIndex] ||
          s?.gameState?.stage !== out.stage ||
          s.decisionKey !== api.buildHorseDecisionKey(s)
        )
          continue;
        const context = plan.kind === 'current' ? plan.context : undefined;
        api.decodeHorseDecisionReads(
          c.readFrame,
          s.gameState.players,
          api.horsePlanHandKey(s.gameState.actionHistory, context),
          context
        );
        if (packet.version === 3) {
          out.contextBinding = horseTurnContextBinding(expected.context, s);
          if (out.contextBinding !== 'matched') continue;
        }
        out.inputBinding = 'canonical_digest_and_read_frame';
        if (packet.version === 3) out.historyReason = horseTurnHistoryReason(s, api);
        out.publicRead = api.horseObserverReadsUsedPublicPool(c.observerReads, s)
          ? 'pooled_public'
          : api.horseObserverReadsWereIndependent(c.observerReads, s)
            ? 'independent'
            : 'unqualified';
        const receipt = c.observerReads;
        out.historicalRead =
          out.publicRead !== 'unqualified' && receipt?.history === 'own_public_window'
            ? 'loaded'
            : s.ownPublicHistoryState === 'pending'
              ? 'pending'
              : s.ownPublicHistoryState === 'unavailable'
                ? 'unavailable'
                : receipt?.history === 'volatile_only'
                  ? 'volatile_only'
                  : 'unknown';
        const envelope = (q) => ({
          producerId: q.producerId,
          sourceRelease: q.sourceRelease,
          handKey: q.handKey,
          sequence: q.sequence,
        });
        const originals = records
          .filter((q) => q.kind === 'decision' && q.producerId === r.producerId)
          .map((q) => ({ ...JSON.parse(q.body), recordEnvelope: envelope(q) }));
        out.phases = closedPhases(
          interpreter.interpret(
            c,
            w,
            api.reviewHorsePlanEffects(
              records.filter(
                (q) =>
                  q.kind === 'accepted_hand' ||
                  (q.turnKey === r.turnKey && q.producerId === r.producerId)
              ),
              expected.handKey
            ),
            originals,
            envelope(r)
          )
        );
      }
    } catch {
      if (result.boundReached) break;
    }
  }
  result.missingTurns = turns.filter((t) => t.capture === 'missing').length;
  result.contradictoryTurns = turns.filter(
    (t) => t.expectedBinding === 'contradictory' || t.capture === 'ambiguous'
  ).length;
  result.status =
    turns.length > 0 &&
    !result.boundReached &&
    !result.remainingHands &&
    turns.every(
      (t) =>
        t.expectedBinding === 'matched' &&
        t.capture === 'present' &&
        t.execution === 'intended' &&
        t.selection === 'matched' &&
        ['canonical_digest_and_read_frame', 'original_discard_request_and_controller'].includes(
          t.inputBinding
        )
    ) &&
    result.extraneousCaptures === 0 &&
    result.unboundCaptures === 0
      ? 'observed'
      : 'unknown';
  return result;
}
export async function loadInstalledTurnCensusApis() {
  const paths = [
    '/app/dist/services/horseDecisionJournal/config.js',
    '/app/dist/services/horseDecisionJournal/store.js',
    '/app/dist/services/horseDecisionJournal/record.js',
    '/app/dist/services/horseDecisionJournal/review.js',
    '/app/dist/services/horseDecisionJournal/effects.js',
    '/app/dist/services/horseDecisionJournal/discard.js',
    '/app/dist/services/horseDecisionJournal/phaseProof.js',
    '/app/dist/engine/HorseDecisionHandBinding.js',
    '/app/dist/engine/HorseDecisionReadFrame.js',
    '/app/dist/engine/HorseDecisionEffects.js',
    '/app/dist/engine/HorseObserverReadEvidence.js',
    '/app/dist/engine/horseDecision/protocol.js',
  ];
  const api = Object.assign(
    {},
    ...(await Promise.all(paths.map((p) => import(/* @vite-ignore */ p))))
  );
  // Optional on older installed images: missing context helpers leave reason unknown.
  try {
    Object.assign(
      api,
      await import(/* @vite-ignore */ '/app/dist/engine/HorseObserverReadContext.js')
    );
  } catch {}
  return api;
}
/** Fixed read-only mount; never opens a writer or exports its private records. */
export function readInstalledTurnCensusBatch(
  packet,
  api,
  directory = '/var/lib/club-arena/horse-decisions'
) {
  validateHorseTurnCensusPacket(packet);
  if (directory !== '/var/lib/club-arena/horse-decisions') throw Error('mount_refused');
  const stores = [],
    started = performance.now(),
    readBudget = { validatedBytes: 0, elapsedMs: 0, boundReached: false };
  const recordsByHand = packet.hands.map((h) => ({ handKey: h.handKey, records: [] }));
  const check = () => {
    readBudget.elapsedMs = performance.now() - started;
    if (readBudget.elapsedMs >= 30000 || readBudget.validatedBytes > 64 * 1024 * 1024) {
      readBudget.boundReached = true;
      throw Error('bound_reached');
    }
  };
  try {
    const names = api.horseJournalArchiveDirectoryNames(directory);
    if (names.length > 32) {
      readBudget.boundReached = true;
      throw Error('shard_bound');
    }
    for (const name of names.length ? names : ['archive']) {
      check();
      stores.push(
        new api.HorseDecisionJournalStore(
          directory,
          api.readonlyHorseJournalStoreOptions(directory, name)
        )
      );
    }
    for (const entry of recordsByHand) {
      try {
        check();
        const records = new Map();
        let uniqueBytes = 0;
        for (const store of stores)
          for (const r of store.readHand(entry.handKey)) {
            check();
            api.validateHorseJournalRecord(r);
            const encoded = api.horseJournalJson(r),
              size = Buffer.byteLength(encoded);
            readBudget.validatedBytes += size;
            check();
            if (records.has(r.eventId)) {
              if (api.horseJournalJson(records.get(r.eventId)) !== encoded)
                throw Error('record_conflict');
              continue;
            }
            uniqueBytes += size;
            if (records.size >= 256 || uniqueBytes > 8 * 1024 * 1024) throw Error('hand_bound');
            records.set(r.eventId, r);
          }
        entry.records = [...records.values()];
      } catch {
        if (readBudget.boundReached) break;
      }
    }
  } catch {
    /* Every expected domain remains present with empty unavailable records. */
  } finally {
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* Read-only handle cleanup cannot qualify any record. */
      }
    }
    readBudget.elapsedMs = performance.now() - started;
  }
  return { sourceRelease: packet.sourceSha, recordsByHand, readBudget };
}
/** Refuse unknown fields rather than removing a private payload after the fact. */
export function sanitizeHorseTurnCensusResult(v) {
  const root = [
    'version',
    'scope',
    'status',
    'rawRecordsExported',
    'replayVerified',
    'completePopulation',
    'strategyCorrectnessVerified',
    'activationAllowed',
    'sourceSha',
    'packetDigest',
    'expectedTurns',
    'validatedBytes',
    'boundReached',
    'missingTurns',
    'contradictoryTurns',
    'extraneousCaptures',
    'unboundCaptures',
    'inspectedHands',
    'remainingHands',
    'turns',
  ];
  if (
    !exact(v, root) ||
    ![2, 3].includes(v.version) ||
    v.scope !== 'supplied_committed_turn_census' ||
    !['observed', 'unknown'].includes(v.status) ||
    !hex(v.sourceSha, 40) ||
    !hex(v.packetDigest, 64) ||
    [
      'rawRecordsExported',
      'replayVerified',
      'completePopulation',
      'strategyCorrectnessVerified',
      'activationAllowed',
    ].some((k) => v[k] !== false) ||
    typeof v.boundReached !== 'boolean' ||
    !Array.isArray(v.turns) ||
    v.turns.length > 1024 ||
    v.expectedTurns !== v.turns.length
  )
    throw Error('result_refused');
  for (const k of [
    'expectedTurns',
    'validatedBytes',
    'missingTurns',
    'contradictoryTurns',
    'extraneousCaptures',
    'unboundCaptures',
    'inspectedHands',
    'remainingHands',
  ])
    if (!Number.isSafeInteger(v[k]) || v[k] < 0) throw Error('result_refused');
  const seen = new Set();
  const states = {
    expectedBinding: ['unknown', 'matched', 'contradictory'],
    capture: ['missing', 'present', 'ambiguous'],
    execution: ['missing', 'ambiguous', 'intended', 'coerced', 'retired', 'unknown'],
    selection: ['unknown', 'matched'],
    inputBinding: [
      'unknown',
      'canonical_digest_and_read_frame',
      'original_discard_request_and_controller',
    ],
    publicRead: ['unknown', 'pooled_public', 'independent', 'unqualified', 'not_applicable'],
    historicalRead: [
      'unknown',
      'loaded',
      'pending',
      'unavailable',
      'volatile_only',
      'not_applicable',
    ],
    handReconciliation: ['unknown', 'reconciled', 'incomplete'],
  };
  for (const t of v.turns) {
    if (
      !exact(t, [
        'actorIndex',
        'handKey',
        'actionOrdinal',
        'stage',
        'action',
        'origin',
        ...Object.keys(states),
        'phases',
        ...(v.version === 3 ? ['contextBinding', 'historyReason'] : []),
      ]) ||
      (v.version === 3 &&
        (!['unknown', 'matched', 'contradictory'].includes(t.contextBinding) ||
          !['unknown', ...Object.values(historyReasons).flat()].includes(t.historyReason) ||
          (t.historyReason !== 'unknown' &&
            t.inputBinding !== 'canonical_digest_and_read_frame'))) ||
      !Number.isSafeInteger(t.actorIndex) ||
      t.actorIndex < 0 ||
      t.actorIndex >= 1000 ||
      !hex(t.handKey, 64) ||
      !Number.isSafeInteger(t.actionOrdinal) ||
      t.actionOrdinal < 0 ||
      t.actionOrdinal >= 4096 ||
      !stages.includes(t.stage) ||
      !actions.includes(t.action) ||
      !origins.includes(t.origin) ||
      Object.entries(states).some(([k, values]) => !values.includes(t[k]))
    )
      throw Error('result_refused');
    if (
      (t.inputBinding === 'original_discard_request_and_controller' &&
        (t.action !== 'discard' ||
          !['pineapple_discard', 'flop'].includes(t.stage) ||
          t.expectedBinding !== 'matched' ||
          t.capture !== 'present' ||
          t.execution !== 'intended' ||
          t.selection !== 'matched' ||
          t.handReconciliation !== 'reconciled' ||
          t.publicRead !== 'not_applicable' ||
          t.historicalRead !== 'not_applicable')) ||
      (t.inputBinding === 'canonical_digest_and_read_frame' && t.action === 'discard') ||
      ((t.publicRead === 'not_applicable' || t.historicalRead === 'not_applicable') &&
        t.inputBinding !== 'original_discard_request_and_controller' &&
        t.origin !== 'forced')
    )
      throw Error('result_refused');
    if (
      v.version === 3 &&
      ((t.contextBinding === 'matched' &&
        (t.inputBinding !== 'canonical_digest_and_read_frame' ||
          t.capture !== 'present' ||
          t.expectedBinding !== 'matched' ||
          t.handReconciliation !== 'reconciled')) ||
        (t.inputBinding === 'canonical_digest_and_read_frame' && t.contextBinding !== 'matched'))
    )
      throw Error('context_consumption_refused');
    const key = `${t.handKey}:${t.actionOrdinal}`;
    if (seen.has(key)) throw Error('result_refused');
    seen.add(key);
    if (!exact(t.phases, Object.keys(unknownPhase()))) throw Error('result_refused');
    for (const p of Object.values(t.phases))
      if (
        !exact(p, [
          'status',
          'capability',
          'eligibility',
          'qualification',
          'application',
          'reasonSha256',
        ]) ||
        ![
          'applicable-active',
          'shadow',
          'refused',
          'outside-domain',
          'unobserved',
          'unknown',
        ].includes(p.status) ||
        !['captured', 'unobserved'].includes(p.capability) ||
        !['eligible', 'outside-domain', 'unknown'].includes(p.eligibility) ||
        !['verified', 'owner-forced', 'unknown', 'refused'].includes(p.qualification) ||
        !['accepted', 'not-selected', 'shadow', 'refused', 'not-applicable', 'unknown'].includes(
          p.application
        ) ||
        !(p.reasonSha256 === null || hex(p.reasonSha256, 64))
      )
        throw Error('result_refused');
  }
  if (
    v.missingTurns !== v.turns.filter((t) => t.capture === 'missing').length ||
    v.contradictoryTurns !==
      v.turns.filter((t) => t.expectedBinding === 'contradictory' || t.capture === 'ambiguous')
        .length ||
    v.inspectedHands + v.remainingHands > 64 ||
    (v.status === 'observed' &&
      (v.expectedTurns === 0 ||
        v.boundReached ||
        v.remainingHands ||
        v.extraneousCaptures ||
        v.unboundCaptures ||
        v.turns.some(
          (t) =>
            t.expectedBinding !== 'matched' ||
            t.capture !== 'present' ||
            t.execution !== 'intended' ||
            t.selection !== 'matched' ||
            ![
              'canonical_digest_and_read_frame',
              'original_discard_request_and_controller',
            ].includes(t.inputBinding)
        )))
  )
    throw Error('result_refused');
  const encoded = JSON.stringify(v);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw Error('output_bound');
  return JSON.parse(encoded);
}
