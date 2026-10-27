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
    input.version !== 1 ||
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
      ]) ||
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
    version: 1,
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
      if (decisions.length !== 1)
        return unknown(
          decisions.length ? 'matching_decision_ambiguous' : 'matching_decision_missing'
        );
      const { r, capture, predicates } = decisions[0],
        s = capture.snapshot;
      const hand = JSON.parse(accepted[0].body),
        coordinate = `${c.tableId}:${c.handNumber}:${c.leaseGeneration}`;
      if (
        hand.committedHandId !== c.handId ||
        api.horseCompletedHandKey(hand) !== coordinate ||
        accepted[0].turnKey !== c.handKey
      )
        return unknown('accepted_hand_binding_mismatch');
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
