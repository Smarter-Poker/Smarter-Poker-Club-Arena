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
