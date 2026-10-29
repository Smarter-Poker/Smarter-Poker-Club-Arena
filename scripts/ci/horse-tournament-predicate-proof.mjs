/** Private retained-record predicates only. No policy execution, I/O or live certificate. */
import { createHash } from 'node:crypto';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const hex = (value, size) =>
  typeof value === 'string' && new RegExp(`^[0-9a-f]{${size}}$`).test(value);
const uuid = (value) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
export function tournamentPredicateInputIsValid(input, expectedSource) {
  if (
    !exact(input, ['version', 'sourceRelease', 'cases']) ||
    ![1, 2].includes(input.version) ||
    !hex(expectedSource, 40) ||
    input.sourceRelease !== expectedSource ||
    !Array.isArray(input.cases) ||
    !input.cases.length ||
    input.cases.length > 6 ||
    Buffer.byteLength(JSON.stringify(input)) > 8192
  )
    return false;
  const seen = new Set();
  return input.cases.every((c) => {
    if (
      !exact(c, [
        'handKey',
        'tableId',
        'handId',
        'handNumber',
        'leaseGeneration',
        'decisionRecordSha256',
        ...(input.version === 2 ? ['actionOrdinal'] : []),
      ]) ||
      (input.version === 2 &&
        (!Number.isSafeInteger(c.actionOrdinal) ||
          c.actionOrdinal < 0 ||
          c.actionOrdinal >= 4096)) ||
      !hex(c.handKey, 64) ||
      !uuid(c.tableId) ||
      !uuid(c.handId) ||
      !uuid(c.leaseGeneration) ||
      !Number.isSafeInteger(c.handNumber) ||
      c.handNumber < 1 ||
      (c.decisionRecordSha256 !== null && !hex(c.decisionRecordSha256, 64)) ||
      c.handKey !== digest(`${c.tableId}:${c.handNumber}:${c.leaseGeneration}`) ||
      seen.has(c.handKey)
    )
      return false;
    seen.add(c.handKey);
    return true;
  });
}

/** Requires actual installed validators; legacy-compatible acceptance alone is insufficient. */
export function explicitTournamentPredicates(capture, api) {
  const s = capture?.snapshot,
    g = s?.gameState,
    t = g?.tournament;
  const receipt = capture?.decision?.tournamentUtility;
  if (
    g?.gameMode !== 'tournament' ||
    !t ||
    t.payoutTermsVersion !== 1 ||
    t.prizePoolFinalized !== true ||
    typeof t.bubbleProtection !== 'boolean' ||
    ![1, 100].includes(t.prizeUnitCents) ||
    !t.finalizedPrizeLadder ||
    t.finalizedPrizeLadder.poolCents !== t.prizePoolCents ||
    !api.validHorseTournamentPayoutTerms(t)
  )
    return null;
  const provenance = t.contextProvenance;
  if (
    !provenance ||
    provenance.version !== 1 ||
    provenance.status !== 'complete' ||
    provenance.source?.contextStatus !== 'complete' ||
    !api.horseTournamentProvenanceIsValid(provenance) ||
    !api.horseTournamentProvenanceMatchesSnapshot(s)
  )
    return null;
  // A valid legacy or Phase 8 receipt does not establish this Phase 7 observation.
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.model !== 'horse-tournament-utility-phase7-round1' ||
    receipt.objective !== 'mtt_payout' ||
    !receipt.evidence ||
    !hex(capture.readFrame?.sha256, 64) ||
    receipt.readFrameSha256 !== capture.readFrame.sha256 ||
    !api.horseTournamentUtilityReceiptIsValid(receipt, capture.decision) ||
    !api.horseDecisionReceiptIsValid(capture.decision, g.gameVariant, {
      player: s.player,
      gameState: g,
    }) ||
    api.horsePhase7EvidenceMismatch(capture.decision, s) !== null
  )
    return null;
  return {
    finalizedLadderValidated: true,
    unitGridAndPoolReserveConserved: true,
    bubbleProtectionCaptured: true,
    bubbleProtectionEnabled: t.bubbleProtection,
    completeOriginalContextProvenance: true,
    phase7ReceiptReadFrameBound: true,
    payoutTermsDigest: t.finalizedPrizeLadder.sourceDigest,
    contextDigest: provenance.source.contextDigest,
    phase7InputDigest: receipt.evidence.inputSha256,
  };
}

/** Whole-hand review owns identity/read-frame/execution agreement. Outputs never copy private values. */
export function inspectTournamentPredicateRecords(input, batch, api) {
  const base = {
    version: input?.version === 2 ? 2 : 1,
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    activationAllowed: false,
    v56Causality: 'unknown',
    previousLevelBranch: 'unknown',
  };
  if (!tournamentPredicateInputIsValid(input, input?.sourceRelease))
    return { ...base, reason: 'input_refused' };
  if (
    !batch ||
    batch.status !== 'canonical_journal_export' ||
    batch.sourceRelease !== input.sourceRelease ||
    !Array.isArray(batch.recordsByHand) ||
    batch.recordsByHand.length !== input.cases.length
  )
    return { ...base, reason: 'journal_source_or_shape_mismatch' };
  const cases = input.cases.map((c, index) => {
    const unknown = (reason) => ({ handKey: c.handKey, status: 'unknown', reason });
    try {
      const entry = batch.recordsByHand[index];
      if (
        !entry ||
        entry.handKey !== c.handKey ||
        !Array.isArray(entry.records) ||
        !entry.records.length ||
        entry.records.length > 256
      )
        return unknown('journal_missing_or_bounds');
      const seen = new Set(),
        decisions = [],
        accepted = [],
        executions = [];
      for (const r of entry.records) {
        api.validateHorseJournalRecord(r);
        if (
          r.handKey !== c.handKey ||
          r.sourceRelease !== input.sourceRelease ||
          seen.has(r.eventId)
        )
          return unknown('record_binding_or_duplicate');
        seen.add(r.eventId);
        if (r.kind === 'accepted_hand') accepted.push(r);
        if (r.kind === 'execution') executions.push(r);
        if (
          r.kind === 'decision' &&
          (c.decisionRecordSha256 === null || r.sha256 === c.decisionRecordSha256)
        ) {
          const capture = JSON.parse(r.body),
            predicates = explicitTournamentPredicates(capture, api);
          if (predicates) decisions.push({ r, capture, predicates });
        }
      }
      if (accepted.length !== 1) return unknown('accepted_hand_missing_or_ambiguous');
      if (input.version === 1 && decisions.length !== 1)
        return unknown(
          decisions.length ? 'matching_decision_ambiguous' : 'matching_decision_missing'
        );
      const hand = JSON.parse(accepted[0].body),
        coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (
        hand.committedHandId !== c.handId ||
        api.horseCompletedHandKey(hand) !== coordinate ||
        accepted[0].turnKey !== c.handKey
      )
        return unknown('accepted_hand_binding_mismatch');
      let selected = decisions;
      if (input.version === 2) {
        if (
          !Array.isArray(hand.actions) ||
          hand.actions.length > 4096 ||
          c.actionOrdinal >= hand.actions.length
        )
          return unknown('original_action_ordinal_unavailable');
        selected = decisions.filter(({ r }) => {
          const sameTurn = executions.filter(
            (e) => e.producerId === r.producerId && e.turnKey === r.turnKey
          );
          if (sameTurn.length !== 1) return false;
          const bound = api.bindHorseDecisionToCommittedHand(JSON.parse(sameTurn[0].body), hand);
          return bound.status === 'bound' && bound.actionOrdinal === c.actionOrdinal;
        });
      }
      if (selected.length !== 1)
        return unknown(
          selected.length ? 'matching_decision_ambiguous' : 'matching_decision_missing'
        );
      const { r, capture, predicates } = selected[0],
        s = capture.snapshot;
      const anchor = api.anchorHorseDecisionHand(s);
      if (anchor.status !== 'anchored' || api.horseHandAnchorKey(anchor) !== coordinate)
        return unknown('original_snapshot_binding_mismatch');
      const sameTurn = executions.filter(
        (e) => e.producerId === r.producerId && e.turnKey === r.turnKey
      );
      if (sameTurn.length !== 1) return unknown('execution_missing_or_ambiguous');
      const e = sameTurn[0],
        w = JSON.parse(e.body);
      if (
        r.sequence >= e.sequence ||
        w.executionStatus !== 'intended' ||
        w.retirementReason !== null ||
        w.policyFallback === 'brain_exception' ||
        w.selected?.action !== capture.decision.action ||
        w.executedAction !== capture.decision.action ||
        w.acceptedActions?.length !== 1 ||
        w.acceptedActions[0].intended !== true ||
        api.bindHorseDecisionToCommittedHand(w, hand).status !== 'bound'
      )
        return unknown('execution_not_intended');
      const review = api.reconcileHorseJournalHand(entry.records, c.handKey);
      if (
        review.status !== 'reconciled' ||
        !Array.isArray(review.gaps) ||
        review.gaps.length ||
        !(review.matchedActions > 0) ||
        review.matchedActions !== review.acceptedHorseActions
      )
        return unknown('hand_not_reconciled');
      return {
        handKey: c.handKey,
        status: 'observed',
        observation: 'accepted_original_tournament_payout_context',
        decisionRecordSha256: r.sha256,
        executionRecordSha256: e.sha256,
        acceptedRecordSha256: accepted[0].sha256,
        decisionKeySha256: digest(s.decisionKey),
        ...(input.version === 2 ? { actionOrdinal: c.actionOrdinal } : {}),
        ...predicates,
        recordHashesVerified: true,
        originalHandBound: true,
        sameTurnExecution: true,
        intendedActionAccepted: true,
        handReconciled: true,
      };
    } catch {
      return unknown('record_or_validator_unavailable');
    }
  });
  return {
    ...base,
    status: cases.every((c) => c.status === 'observed') ? 'observed' : 'unknown',
    sourceRelease: input.sourceRelease,
    cases,
  };
}

/** Only the existing finite inspector may supply the current-source batch. No transport here. */
export async function loadInstalledTournamentPredicateApi() {
  const paths = [
    '/app/dist/engine/HorseTournamentPayoutTerms.js',
    '/app/dist/engine/HorseTournamentContextProvenance.js',
    '/app/dist/services/horseDecisionJournal/record.js',
    '/app/dist/engine/HorseDecisionHandBinding.js',
    '/app/dist/services/horseDecisionJournal/review.js',
    '/app/dist/engine/horseDecision/responseValidation.js',
  ];
  const modules = await Promise.all(paths.map((path) => import(/* @vite-ignore */ path)));
  return Object.assign({}, ...modules);
}

/** #8464: observe original accepted behavior and installed interpretation only.
 * A helper/wager agreement is deliberately not a causal replay certificate. */
export function inspectDecision8464Records(input, batch, api) {
  const base = {
    version: 4,
    probe: input?.probe,
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    causalReplayVerified: false,
    activationAllowed: false,
  };
  if (
    !exact(input, ['version', 'sourceRelease', 'probe', 'cases']) ||
    input.version !== 4 ||
    Buffer.byteLength(JSON.stringify(input)) > 8192 ||
    !['matched_risk', 'phase7_allocated'].includes(input.probe)
  )
    return { status: 'unknown', reason: 'input_refused' };
  const ordinary = { version: 2, sourceRelease: input.sourceRelease, cases: input.cases };
  if (
    input.version !== 4 ||
    !['matched_risk', 'phase7_allocated'].includes(input.probe) ||
    !tournamentPredicateInputIsValid(ordinary, input.sourceRelease)
  )
    return { ...base, reason: 'input_refused' };
  if (
    !batch ||
    batch.status !== 'canonical_journal_export' ||
    batch.sourceRelease !== input.sourceRelease ||
    !Array.isArray(batch.recordsByHand) ||
    batch.recordsByHand.length !== input.cases.length
  )
    return { ...base, reason: 'journal_source_or_shape_mismatch' };
  const deadline = performance.now() + 5000;
  const budget = () => {
    if (performance.now() >= deadline) throw Error('inspection_bound');
  };
  const cases = input.cases.map((c, index) => {
    const unknown = (reason) => ({ handKey: c.handKey, status: 'unknown', reason });
    try {
      budget();
      const entry = batch.recordsByHand[index];
      if (
        !entry ||
        entry.handKey !== c.handKey ||
        !Array.isArray(entry.records) ||
        !entry.records.length ||
        entry.records.length > 256
      )
        return unknown('journal_missing_or_bounds');
      const records = entry.records,
        seen = new Set(),
        decisions = [],
        executions = [],
        accepted = [];
      for (const r of records) {
        budget();
        api.validateHorseJournalRecord(r);
        if (
          r.handKey !== c.handKey ||
          r.sourceRelease !== input.sourceRelease ||
          seen.has(r.eventId)
        )
          return unknown('record_binding_or_duplicate');
        seen.add(r.eventId);
        if (r.kind === 'accepted_hand') accepted.push(r);
        if (r.kind === 'execution') executions.push(r);
        if (r.kind === 'decision') decisions.push(r);
      }
      if (accepted.length !== 1) return unknown('accepted_hand_missing_or_ambiguous');
      const hand = JSON.parse(accepted[0].body),
        coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (
        hand.committedHandId !== c.handId ||
        api.horseCompletedHandKey(hand) !== coordinate ||
        accepted[0].turnKey !== c.handKey
      )
        return unknown('accepted_hand_binding_mismatch');
      if (
        !Array.isArray(hand.actions) ||
        hand.actions.length > 4096 ||
        c.actionOrdinal >= hand.actions.length
      )
        return unknown('original_action_ordinal_unavailable');
      const selected = [];
      for (const r of decisions) {
        if (c.decisionRecordSha256 !== null && r.sha256 !== c.decisionRecordSha256) continue;
        const sameTurn = executions.filter(
          (e) => e.turnKey === r.turnKey && e.producerId === r.producerId
        );
        if (sameTurn.length !== 1) continue;
        const w = JSON.parse(sameTurn[0].body),
          bound = api.bindHorseDecisionToCommittedHand(w, hand);
        if (bound.status === 'bound' && bound.actionOrdinal === c.actionOrdinal)
          selected.push({ r, e: sameTurn[0], w });
      }
      if (selected.length !== 1)
        return unknown(
          selected.length ? 'matching_decision_ambiguous' : 'matching_decision_missing'
        );
      const { r, e, w } = selected[0],
        capture = JSON.parse(r.body),
        s = capture.snapshot,
        g = s.gameState,
        p = s.player;
      const anchor = api.anchorHorseDecisionHand(s);
      if (anchor.status !== 'anchored' || api.horseHandAnchorKey(anchor) !== coordinate)
        return unknown('original_snapshot_binding_mismatch');
      if (
        r.sequence >= e.sequence ||
        w.executionStatus !== 'intended' ||
        w.retirementReason !== null ||
        w.policyFallback === 'brain_exception' ||
        w.acceptedActions?.length !== 1 ||
        w.acceptedActions[0].intended !== true ||
        w.selected?.action !== capture.decision.action ||
        (w.selected.amount ?? null) !== (capture.decision.amount ?? null) ||
        w.executedAction !== capture.decision.action
      )
        return unknown('execution_not_intended');
      const review = api.reconcileHorseJournalHand(records, c.handKey);
      budget();
      if (
        review.status !== 'reconciled' ||
        !Array.isArray(review.gaps) ||
        review.gaps.length ||
        !(review.matchedActions > 0) ||
        review.matchedActions !== review.acceptedHorseActions
      )
        return unknown('hand_not_reconciled');
      const common = {
        handKey: c.handKey,
        status: 'observed',
        actionOrdinal: c.actionOrdinal,
        decisionRecordSha256: r.sha256,
        executionRecordSha256: e.sha256,
        acceptedRecordSha256: accepted[0].sha256,
        decisionKeySha256: digest(s.decisionKey),
        recordHashesVerified: true,
        originalHandBound: true,
        intendedActionAccepted: true,
        handReconciled: true,
      };
      if (input.probe === 'matched_risk') {
        if (!['flop', 'turn', 'river'].includes(g.stage))
          return unknown('matched_risk_not_observed');
        const matched = api.headsUpCashCommitment(p, g);
        if (
          !matched ||
          !Number.isFinite(matched.exposure) ||
          !(matched.exposure > 0) ||
          !(matched.exposure < p.stack) ||
          matched.wager?.action !== 'raise' ||
          !Number.isFinite(matched.wager.amount) ||
          !(matched.wager.amount > g.currentBet)
        )
          return unknown('matched_risk_not_observed');
        if (capture.decision.action !== 'raise' || capture.decision.amount !== matched.wager.amount)
          return unknown('matched_wager_not_retained');
        return {
          ...common,
          observation: 'accepted_matched_risk_bounded_wager',
          variant: g.gameVariant,
          stage: g.stage,
          exposure: matched.exposure,
          physicalStack: p.stack,
          raiseTo: matched.wager.amount,
          helperEligible: true,
          coveringStack: true,
          finalWagerMatchesHelper: true,
        };
      }
      const plan = api.horseRetainedPlanContext(capture, s),
        history = g.actionHistory;
      if (plan.kind !== 'current' || !Array.isArray(history) || !history.length)
        return unknown('allocated_nonempty_context_not_observed');
      const allocated = api.horsePlanHandKey(history, plan.context),
        legacy = api.horseMindHandKey(history);
      if (
        typeof allocated !== 'string' ||
        !allocated.startsWith('plan-hand-v1:') ||
        allocated === legacy
      )
        return unknown('allocated_nonempty_context_not_observed');
      const envelope = (r) => ({
        producerId: r.producerId,
        sourceRelease: r.sourceRelease,
        handKey: r.handKey,
        sequence: r.sequence,
      });
      const captures = decisions
        .filter((d) => d.producerId === r.producerId)
        .map((d) => ({ ...JSON.parse(d.body), recordEnvelope: envelope(d) }));
      const plans = api.reviewHorsePlanEffects(
        records.filter(
          (d) =>
            d.kind === 'accepted_hand' || (d.turnKey === r.turnKey && d.producerId === r.producerId)
        ),
        c.handKey
      );
      const interpreter = new api.HorseFleetPhaseInterpreter(budget);
      const proof = interpreter.interpret(capture, w, plans, captures, envelope(r)).phase7;
      budget();
      if (
        proof?.status !== 'applicable-active' ||
        proof.reason !== 'supported_uncalibrated_utility_baseline' ||
        !['accepted', 'not-selected'].includes(proof.application)
      )
        return unknown('phase7_interpreter_not_observed');
      return {
        ...common,
        observation: 'allocated_nonempty_phase7_interpreter_observed',
        readFrameSha256: capture.readFrame.sha256,
        allocatedContext: true,
        nonemptyHistory: true,
        allocatedKeyDiffersFromLegacy: true,
        phase7: { status: proof.status, reason: proof.reason, application: proof.application },
      };
    } catch {
      return unknown('record_or_validator_unavailable');
    }
  });
  return {
    ...base,
    sourceRelease: input.sourceRelease,
    cases,
    status: cases.every((c) => c.status === 'observed') ? 'observed' : 'unknown',
  };
}

/** Same fixed installed APIs as the fleet observer, never an uploaded module. */
export async function loadInstalledDecision8464Api() {
  const paths = [
    '/app/dist/services/horseDecisionJournal/record.js',
    '/app/dist/engine/HorseDecisionHandBinding.js',
    '/app/dist/services/horseDecisionJournal/review.js',
    '/app/dist/engine/HorseHeadsUpCommitment.js',
    '/app/dist/services/horseDecisionJournal/phaseProof.js',
    '/app/dist/services/horseDecisionJournal/effects.js',
    '/app/dist/engine/HorseDecisionEffects.js',
  ];
  return Object.assign(
    {},
    ...(await Promise.all(paths.map((path) => import(/* @vite-ignore */ path))))
  );
}

/** Closed observation of one original accepted cash turn fold. Never re-runs policy. */
export function cashTurnFoldInputIsValid(input, source) {
  if (
    !exact(input, ['version', 'sourceRelease', 'probe', 'cases']) ||
    input.version !== 5 ||
    input.probe !== 'cash_turn_fold' ||
    !Array.isArray(input.cases) ||
    Buffer.byteLength(JSON.stringify(input)) > 8192
  )
    return false;
  return tournamentPredicateInputIsValid(
    {
      version: 2,
      sourceRelease: input.sourceRelease,
      cases: input.cases.map((c) => {
        if (
          !exact(c, [
            'handKey',
            'tableId',
            'handId',
            'handNumber',
            'leaseGeneration',
            'decisionRecordSha256',
            'actionOrdinal',
            'actorId',
            'seat',
          ]) ||
          !uuid(c.actorId) ||
          !Number.isInteger(c.seat) ||
          c.seat < 1 ||
          c.seat > 10
        )
          return {};
        const { actorId, seat, ...ordinary } = c;
        return ordinary;
      }),
    },
    source
  );
}
const foldReasons = new Set([
  'off',
  'reference_retained',
  'call_declined',
  'postflop_fold',
  'equity_below_price',
  'insufficient_equity',
  'range_unavailable',
  'invalid_equity_evidence',
  'canonical_state_unavailable',
  'invalid_geometry',
  'invalid_wager_geometry',
  'rake_schedule_unavailable',
  'depth_or_ante_outside_pack',
  'variant_outside_pack',
]);
const finiteNonnegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const capturedUnit = (n) =>
  typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
export function inspectCashTurnFoldRecords(input, batch, api) {
  const base = {
    version: 5,
    probe: 'cash_turn_fold',
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    causalReplayVerified: false,
    activationAllowed: false,
  };
  if (!cashTurnFoldInputIsValid(input, input?.sourceRelease))
    return { ...base, reason: 'input_refused' };
  if (
    !batch ||
    batch.status !== 'canonical_journal_export' ||
    batch.sourceRelease !== input.sourceRelease ||
    !Array.isArray(batch.recordsByHand) ||
    batch.recordsByHand.length !== input.cases.length
  )
    return { ...base, reason: 'journal_source_or_shape_mismatch' };
  const deadline = performance.now() + 5000;
  const budget = () => {
    if (performance.now() >= deadline) throw Error();
  };
  const cases = input.cases.map((c, index) => {
    const unknown = (reason) => ({ handKey: c.handKey, status: 'unknown', reason });
    try {
      const entry = batch.recordsByHand[index];
      if (
        !entry ||
        entry.handKey !== c.handKey ||
        !Array.isArray(entry.records) ||
        !entry.records.length ||
        entry.records.length > 256
      )
        return unknown('journal_missing_or_bounds');
      const decisions = [],
        executions = [],
        accepted = [],
        seen = new Set();
      for (const r of entry.records) {
        budget();
        api.validateHorseJournalRecord(r);
        if (
          r.handKey !== c.handKey ||
          r.sourceRelease !== input.sourceRelease ||
          seen.has(r.eventId)
        )
          return unknown('record_binding_or_duplicate');
        seen.add(r.eventId);
        if (r.kind === 'decision') decisions.push(r);
        if (r.kind === 'execution') executions.push(r);
        if (r.kind === 'accepted_hand') accepted.push(r);
      }
      if (accepted.length !== 1) return unknown('accepted_hand_missing_or_ambiguous');
      const hand = JSON.parse(accepted[0].body),
        coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (
        hand.committedHandId !== c.handId ||
        api.horseCompletedHandKey(hand) !== coordinate ||
        accepted[0].turnKey !== c.handKey
      )
        return unknown('accepted_hand_binding_mismatch');
      if (
        !Array.isArray(hand.actions) ||
        hand.actions.length > 4096 ||
        c.actionOrdinal >= hand.actions.length
      )
        return unknown('original_action_ordinal_unavailable');
      const action = hand.actions[c.actionOrdinal],
        node = action.publicNode;
      if (
        action.action !== 'fold' ||
        action.origin !== 'horse_policy' ||
        action.stage !== 'turn' ||
        action.userId !== c.actorId ||
        action.seat !== c.seat ||
        node?.status !== 'captured' ||
        node.mode !== 'cash' ||
        node.street !== 'turn' ||
        node.actorSeat !== c.seat
      )
        return unknown('original_cash_turn_fold_not_observed');
      const selected = [];
      for (const r of decisions) {
        budget();
        if (c.decisionRecordSha256 !== null && r.sha256 !== c.decisionRecordSha256) continue;
        const same = executions.filter(
          (e) => e.turnKey === r.turnKey && e.producerId === r.producerId
        );
        if (same.length !== 1) continue;
        const w = JSON.parse(same[0].body),
          bound = api.bindHorseDecisionToCommittedHand(w, hand);
        if (bound.status === 'bound' && bound.actionOrdinal === c.actionOrdinal)
          selected.push({ r, e: same[0], w });
      }
      if (selected.length !== 1)
        return unknown(
          selected.length ? 'matching_decision_ambiguous' : 'matching_decision_missing'
        );
      const { r, e, w } = selected[0],
        capture = JSON.parse(r.body),
        s = capture.snapshot,
        g = s?.gameState,
        p = s?.player;
      const anchor = api.anchorHorseDecisionHand(s);
      if (
        anchor.status !== 'anchored' ||
        api.horseHandAnchorKey(anchor) !== coordinate ||
        anchor.actionOrdinal !== c.actionOrdinal ||
        anchor.actorId !== c.actorId ||
        anchor.seat !== c.seat ||
        p?.user_id !== c.actorId ||
        p?.seat !== c.seat ||
        g?.stage !== 'turn' ||
        g.currentPlayerSeat !== c.seat ||
        anchor.earlyLook === true ||
        g.gameMode !== 'cash' ||
        !['nlh', 'plo4', 'plo5', 'plo6'].includes(g.gameVariant) ||
        g.gameVariant !== node.variant ||
        capture.decision?.action !== 'fold'
      )
        return unknown('original_snapshot_binding_mismatch');
      const ar = w.acceptedActions?.[0]?.record;
      if (
        r.sequence >= e.sequence ||
        (e.producerId === accepted[0].producerId && e.sequence >= accepted[0].sequence) ||
        w.executionStatus !== 'intended' ||
        w.retirementReason !== null ||
        w.policyFallback === 'brain_exception' ||
        w.selected?.action !== 'fold' ||
        (w.selected.amount ?? null) !== (capture.decision.amount ?? null) ||
        w.executedAction !== 'fold' ||
        w.acceptedActions?.length !== 1 ||
        w.acceptedActions[0].intended !== true ||
        ar?.action !== 'fold' ||
        ar.stage !== 'turn' ||
        ar.userId !== c.actorId ||
        ar.seat !== c.seat
      )
        return unknown('execution_not_intended');
      const heroes = node.seats?.filter((row) => Array.isArray(row) && row[0] === c.seat);
      const hero = heroes?.length === 1 ? heroes[0] : null;
      const requestHeroes = g.players?.filter(
        (row) => row.seat === c.seat && row.user_id === c.actorId
      );
      const ownCardCount = { nlh: 2, plo4: 4, plo5: 5, plo6: 6 }[g.gameVariant];
      if (
        !finiteNonnegative(p.stack) ||
        !(p.stack > 0) ||
        !finiteNonnegative(p.bet) ||
        !finiteNonnegative(g.currentBet) ||
        !finiteNonnegative(g.pot) ||
        !hero ||
        !Array.isArray(p.cards) ||
        p.cards.length !== ownCardCount ||
        !Array.isArray(g.communityCards) ||
        g.communityCards.length !== 4 ||
        requestHeroes?.length !== 1 ||
        requestHeroes[0].stack !== p.stack ||
        requestHeroes[0].bet !== p.bet ||
        hero[1] !== p.stack ||
        hero[2] !== p.bet ||
        node.currentBet !== g.currentBet ||
        node.pot !== g.pot ||
        node.toCall !== Math.max(0, g.currentBet - p.bet) ||
        !(node.toCall > 0) ||
        (Object.hasOwn(g, 'contestablePot') && !finiteNonnegative(g.contestablePot))
      )
        return unknown('original_price_geometry_unavailable');
      const review = api.reconcileHorseJournalHand(entry.records, c.handKey);
      budget();
      if (
        review.status !== 'reconciled' ||
        !Array.isArray(review.gaps) ||
        review.gaps.length ||
        !(review.matchedActions > 0) ||
        review.matchedActions !== review.acceptedHorseActions
      )
        return unknown('hand_not_reconciled');
      const effectiveCall = Math.min(node.toCall, p.stack),
        uncallableExcess = node.toCall - effectiveCall;
      const derivedContestablePot = Object.hasOwn(g, 'contestablePot')
        ? g.contestablePot
        : g.pot - uncallableExcess;
      if (!(derivedContestablePot >= 0)) return unknown('original_price_geometry_unavailable');
      const policyReceipts = ['plo4Policy', 'omahaVariantPolicy', 'remainingVariantPolicy'].map(
        (owner) => {
          const receipt = capture.decision[owner];
          return {
            owner,
            present: receipt != null,
            mode: ['off', 'shadow', 'candidate'].includes(receipt?.mode) ? receipt.mode : null,
            applied: typeof receipt?.applied === 'boolean' ? receipt.applied : null,
            callPrice: capturedUnit(receipt?.callPrice),
            equity: capturedUnit(receipt?.equity?.equity),
            reason: foldReasons.has(receipt?.reason) ? receipt.reason : null,
          };
        }
      );
      return {
        handKey: c.handKey,
        status: 'observed',
        observation: 'accepted_original_cash_turn_fold',
        actionOrdinal: c.actionOrdinal,
        decisionRecordSha256: r.sha256,
        executionRecordSha256: e.sha256,
        acceptedRecordSha256: accepted[0].sha256,
        decisionKeySha256: digest(s.decisionKey),
        recordHashesVerified: true,
        originalHandBound: true,
        intendedActionAccepted: true,
        handReconciled: true,
        variant: g.gameVariant,
        ownCardCount:
          Array.isArray(p.cards) && [2, 4, 5, 6].includes(p.cards.length) ? p.cards.length : null,
        ownMadeCategory: null,
        rawCall: node.toCall,
        effectiveCall,
        uncallableExcess,
        stack: p.stack,
        pot: g.pot,
        capturedContestablePot: Object.hasOwn(g, 'contestablePot') ? g.contestablePot : null,
        derivedReference: {
          contestablePot: derivedContestablePot,
          unrakedCallPrice: effectiveCall / (derivedContestablePot + effectiveCall),
        },
        policyReceipts,
        originalReferenceEquity: null,
        originalReferenceReason: null,
      };
    } catch {
      return unknown('record_or_validator_unavailable');
    }
  });
  return {
    ...base,
    sourceRelease: input.sourceRelease,
    cases,
    status: cases.every((c) => c.status === 'observed') ? 'observed' : 'unknown',
  };
}
export async function loadInstalledCashTurnFoldApi() {
  const paths = [
    '/app/dist/services/horseDecisionJournal/record.js',
    '/app/dist/engine/HorseDecisionHandBinding.js',
    '/app/dist/services/horseDecisionJournal/review.js',
  ];
  return Object.assign(
    {},
    ...(await Promise.all(paths.map((path) => import(/* @vite-ignore */ path))))
  );
}

const allInReviewGaps = new Set([
  'request_lifecycle_missing',
  'request_lifecycle_conflict',
  'request_lifecycle_mismatch',
  'storage_unavailable',
  'invalid_records',
  'record_conflict',
  'accepted_hand_missing',
  'accepted_hand_conflict',
  'decision_missing',
  'execution_missing',
  'turn_conflict',
  'input_mismatch',
  'decision_effects_missing',
  'decision_effects_invalid',
  'read_frame_unavailable',
  'binding_unavailable',
  'multiple_decisions_for_action',
  'unmatched_horse_action',
  'fallback_lineage_unavailable',
  'action_origin_unavailable',
  'discard_decision_missing',
  'discard_execution_missing',
  'discard_capture_conflict',
  'discard_input_mismatch',
  'discard_binding_unavailable',
  'unmatched_discard_action',
]);
const allInBindingReasons = new Set([
  'invalid_turn_identity',
  'missing_prior_actions',
  'invalid_prior_actions',
  'invalid_committed_identity',
  'hand_fence_mismatch',
  'execution_unavailable',
  'prior_actions_mismatch',
  'accepted_action_mismatch',
  'observation_identity_unavailable',
  'committed_identity_conflict',
  'multiple_decisions_for_action',
  'tracking_capacity',
  'tracking_expired',
]);
const allInLifecycleOutcomes = ['success', 'refused', 'cancelled', 'expired', 'exception'];
function allInClosedReasons(values, allowed) {
  const counts = {};
  let otherCount = 0;
  for (const value of values)
    if (allowed.has(value)) counts[value] = (counts[value] ?? 0) + 1;
    else otherCount++;
  return { counts, otherCount };
}

/** Original accepted-all-in facts only; normalization labels are derived, never a policy verdict. */
export function acceptedAllInExecutionInputIsValid(input, source) {
  return (
    exact(input, ['version', 'sourceRelease', 'probe', 'cases']) &&
    input.version === 6 &&
    input.probe === 'accepted_all_in_execution' &&
    cashTurnFoldInputIsValid({ ...input, version: 5, probe: 'cash_turn_fold' }, source)
  );
}
export function inspectAcceptedAllInExecutionRecords(input, batch, api) {
  const base = {
    version: 6,
    probe: 'accepted_all_in_execution',
    status: 'unknown',
    rawRecordsExported: false,
    replayVerified: false,
    causalReplayVerified: false,
    activationAllowed: false,
  };
  if (!acceptedAllInExecutionInputIsValid(input, input?.sourceRelease))
    return { ...base, reason: 'input_refused' };
  if (
    !batch ||
    batch.status !== 'canonical_journal_export' ||
    batch.sourceRelease !== input.sourceRelease ||
    !Array.isArray(batch.recordsByHand) ||
    batch.recordsByHand.length !== input.cases.length
  )
    return { ...base, reason: 'journal_source_or_shape_mismatch' };
  const deadline = performance.now() + 5000;
  const budget = () => {
    if (performance.now() >= deadline) throw Error();
  };
  const cases = input.cases.map((c, index) => {
    let counts = null,
      diagnostics = null;
    const unknown = (reason) => ({
      handKey: c.handKey,
      status: 'unknown',
      reason,
      counts,
      diagnostics,
    });
    try {
      const entry = batch.recordsByHand[index];
      if (
        !entry ||
        entry.handKey !== c.handKey ||
        !Array.isArray(entry.records) ||
        !entry.records.length ||
        entry.records.length > 256
      )
        return unknown('journal_missing_or_bounds');
      const decisions = [],
        executions = [],
        accepted = [],
        seen = new Set();
      for (const r of entry.records) {
        budget();
        api.validateHorseJournalRecord(r);
        if (
          r.handKey !== c.handKey ||
          r.sourceRelease !== input.sourceRelease ||
          seen.has(r.eventId)
        )
          return unknown('record_binding_or_duplicate');
        seen.add(r.eventId);
        if (r.kind === 'decision') decisions.push(r);
        if (r.kind === 'execution') executions.push(r);
        if (r.kind === 'accepted_hand') accepted.push(r);
      }
      counts = {
        decisionRecords: decisions.length,
        executionRecords: executions.length,
        matchingDecisions: 0,
        matchingExecutions: 0,
        matchingPairs: 0,
      };
      if (accepted.length !== 1) return unknown('accepted_hand_missing_or_ambiguous');
      const hand = JSON.parse(accepted[0].body),
        coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (
        hand.committedHandId !== c.handId ||
        api.horseCompletedHandKey(hand) !== coordinate ||
        accepted[0].turnKey !== c.handKey
      )
        return unknown('accepted_hand_binding_mismatch');
      const action = hand.actions?.[c.actionOrdinal];
      if (
        !Array.isArray(hand.actions) ||
        hand.actions.length > 4096 ||
        !action ||
        action.action !== 'all_in' ||
        action.origin !== 'horse_policy' ||
        action.userId !== c.actorId ||
        action.seat !== c.seat ||
        !['preflop', 'flop', 'turn', 'river'].includes(action.stage)
      )
        return unknown('accepted_action_not_observed');
      const review = api.reconcileHorseJournalHand(entry.records, c.handKey);
      diagnostics = {
        wholeHandReview: {
          scope: 'whole_original_hand',
          status: review.status,
          gapCounts: allInClosedReasons(review.gaps, allInReviewGaps),
          requestedRequests: review.requestedRequests,
          terminalRequests: review.terminalRequests,
          requestLifecycleVerified: review.requestLifecycleVerified,
        },
        targetBinder: {
          scope: 'original_target_anchor',
          targetExecutions: 0,
          boundExecutions: 0,
          refusalCounts: { counts: {}, otherCount: 0 },
        },
        targetLifecycle: {
          scope: 'original_target_request_digest',
          requested: 0,
          terminal: 0,
          terminalOutcomes: Object.fromEntries(allInLifecycleOutcomes.map((k) => [k, 0])),
        },
      };
      const targetAnchor = (a) =>
        a?.status === 'anchored' &&
        api.horseHandAnchorKey(a) === coordinate &&
        a.actionOrdinal === c.actionOrdinal &&
        a.actorId === c.actorId &&
        a.seat === c.seat &&
        a.earlyLook !== true;
      const admissions = [];
      for (const record of entry.records) {
        budget();
        if (record.kind !== 'request_lifecycle') continue;
        const body = JSON.parse(record.body);
        if (body.phase !== 'requested') continue;
        try {
          api.validateHorseRequestLifecycle(body);
          const request = body.request,
            keys = api.horseLifecycleKeys(request);
          if (
            targetAnchor(api.anchorHorseDecisionHand(request)) &&
            request.player?.user_id === c.actorId &&
            request.player?.seat === c.seat &&
            request.gameState?.stage === action.stage &&
            digest(keys.hand) === c.handKey &&
            digest(keys.turn) === record.turnKey
          )
            admissions.push({ record, body });
        } catch {
          /* Unknown records never gain target attribution. Whole-hand gaps remain visible. */
        }
      }
      diagnostics.targetLifecycle.requested = admissions.length;
      for (const record of entry.records) {
        budget();
        if (record.kind !== 'request_lifecycle') continue;
        const body = JSON.parse(record.body);
        if (body.phase !== 'terminal') continue;
        try {
          api.validateHorseRequestLifecycle(body);
          if (
            admissions.some(
              (a) =>
                a.record.producerId === record.producerId &&
                a.record.turnKey === record.turnKey &&
                a.body.requestDigest === body.requestDigest
            )
          ) {
            diagnostics.targetLifecycle.terminal++;
            diagnostics.targetLifecycle.terminalOutcomes[body.outcome]++;
          }
        } catch {
          /* No unvalidated phase/outcome may leave the boundary. */
        }
      }
      const matchingDecisions = [];
      for (const r of decisions) {
        budget();
        if (c.decisionRecordSha256 !== null && r.sha256 !== c.decisionRecordSha256) continue;
        const capture = JSON.parse(r.body),
          s = capture.snapshot,
          a = api.anchorHorseDecisionHand(s);
        if (
          a.status === 'anchored' &&
          api.horseHandAnchorKey(a) === coordinate &&
          a.actionOrdinal === c.actionOrdinal &&
          a.actorId === c.actorId &&
          a.seat === c.seat &&
          a.earlyLook !== true &&
          s.player?.user_id === c.actorId &&
          s.player?.seat === c.seat &&
          s.gameState?.stage === action.stage &&
          s.gameState.currentPlayerSeat === c.seat
        )
          matchingDecisions.push({ r, capture });
      }
      const matchingExecutions = [];
      for (const e of executions) {
        budget();
        const w = JSON.parse(e.body);
        if (!targetAnchor(w.handAnchor) || w.identity?.stage !== action.stage) continue;
        diagnostics.targetBinder.targetExecutions++;
        const b = api.bindHorseDecisionToCommittedHand(w, hand);
        if (b.status === 'bound' && b.actionOrdinal === c.actionOrdinal) {
          diagnostics.targetBinder.boundExecutions++;
          matchingExecutions.push({ e, w });
        } else {
          const reasons = diagnostics.targetBinder.refusalCounts;
          if (allInBindingReasons.has(b.reason))
            reasons.counts[b.reason] = (reasons.counts[b.reason] ?? 0) + 1;
          else reasons.otherCount++;
        }
      }
      counts.matchingDecisions = matchingDecisions.length;
      counts.matchingExecutions = matchingExecutions.length;
      const pairs = [];
      for (const d of matchingDecisions)
        for (const x of matchingExecutions)
          if (d.r.producerId === x.e.producerId && d.r.turnKey === x.e.turnKey)
            pairs.push({ ...d, ...x });
      counts.matchingPairs = pairs.length;
      // Counts describe this bounded read, never prove records never existed.
      if (pairs.length !== 1)
        return unknown(pairs.length ? 'matching_pair_ambiguous' : 'matching_pair_missing');
      const { r, capture, e, w } = pairs[0],
        s = capture.snapshot,
        p = s.player,
        g = s.gameState;
      if (
        r.sequence >= e.sequence ||
        (e.producerId === accepted[0].producerId && e.sequence >= accepted[0].sequence) ||
        !['intended', 'coerced'].includes(w.executionStatus) ||
        w.retirementReason !== null ||
        w.policyFallback === 'brain_exception' ||
        w.acceptedActions?.length !== 1 ||
        w.acceptedActions[0].intended !== true ||
        w.executedAction !== 'all_in'
      )
        return unknown('execution_binding_mismatch');
      if (
        review.status !== 'reconciled' ||
        review.gaps.length ||
        !(review.matchedActions > 0) ||
        review.matchedActions !== review.acceptedHorseActions
      )
        return unknown('hand_not_reconciled');
      const ar = w.acceptedActions[0].record,
        selected = w.selected;
      const actions = new Set(['fold', 'check', 'call', 'bet', 'raise', 'all_in']);
      const number = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (
        !actions.has(selected?.action) ||
        !actions.has(capture.decision?.action) ||
        ![
          p.stack,
          p.bet,
          w.expectedExecutionAmount,
          w.executedAmount,
          ar.amount,
          action.amount,
        ].every(number) ||
        !(p.stack > 0) ||
        !(ar.amount > 0) ||
        (selected.amount !== null && selected.amount !== undefined && !number(selected.amount)) ||
        (capture.decision.amount !== undefined && !number(capture.decision.amount)) ||
        ar.action !== 'all_in' ||
        ar.stage !== action.stage ||
        ar.userId !== c.actorId ||
        ar.seat !== c.seat ||
        ar.amount !== action.amount ||
        ar.amount !== w.executedAmount ||
        (ar.isFullRaise !== undefined && typeof ar.isFullRaise !== 'boolean') ||
        !['cash', 'tournament'].includes(g.gameMode) ||
        !['nlh', 'plo4', 'plo5', 'plo6'].includes(g.gameVariant)
      )
        return unknown('geometry_unavailable');
      const actionTypeMatches = selected.action === ar.action,
        amountMatches = w.expectedExecutionAmount === ar.amount;
      if ((w.executionStatus === 'intended') !== (actionTypeMatches && amountMatches))
        return unknown('execution_binding_mismatch');
      const wholeStack = Math.round((p.stack + p.bet) * 100) / 100;
      const normalizationKind =
        actionTypeMatches && amountMatches
          ? 'unchanged'
          : !actionTypeMatches &&
              amountMatches &&
              ['bet', 'raise'].includes(selected.action) &&
              selected.amount === ar.amount &&
              wholeStack === ar.amount
            ? 'sized_wager_promoted_to_all_in'
            : actionTypeMatches
              ? 'amount_changed'
              : amountMatches
                ? 'action_type_changed'
                : 'action_and_amount_changed';
      return {
        handKey: c.handKey,
        status: 'observed',
        observation: 'accepted_original_all_in_execution',
        actionOrdinal: c.actionOrdinal,
        stage: action.stage,
        variant: g.gameVariant,
        mode: g.gameMode,
        counts,
        diagnostics,
        normalizationComparison: 'selected_vs_accepted',
        capturedVsSelectedActionMatches: capture.decision.action === selected.action,
        capturedVsSelectedAmountMatches:
          (capture.decision.amount ?? null) === (selected.amount ?? null),
        decisionRecordSha256: r.sha256,
        executionRecordSha256: e.sha256,
        acceptedRecordSha256: accepted[0].sha256,
        decisionKeySha256: digest(s.decisionKey),
        recordHashesVerified: true,
        originalHandBound: true,
        acceptedActionBound: true,
        handReconciled: true,
        capturedAction: capture.decision.action,
        capturedAmount: capture.decision.amount ?? null,
        selectedAction: selected.action,
        selectedAmount: selected.amount ?? null,
        expectedExecutionAmount: w.expectedExecutionAmount,
        executedAction: w.executedAction,
        executedAmount: w.executedAmount,
        acceptedAction: ar.action,
        acceptedAmount: ar.amount,
        acceptedIsFullRaise: ar.isFullRaise ?? null,
        stack: p.stack,
        bet: p.bet,
        executionStatus: w.executionStatus,
        actionTypeMatches,
        amountMatches,
        derivedNormalizationKind: normalizationKind,
        originalNormalizationReason: null,
      };
    } catch {
      return unknown('record_or_validator_unavailable');
    }
  });
  return {
    ...base,
    sourceRelease: input.sourceRelease,
    cases,
    status: cases.every((c) => c.status === 'observed') ? 'observed' : 'unknown',
  };
}
export async function loadInstalledAcceptedAllInExecutionApi() {
  return {
    ...(await loadInstalledCashTurnFoldApi()),
    ...(await import('/app/dist/services/horseDecisionJournal/lifecycle.js')),
  };
}
