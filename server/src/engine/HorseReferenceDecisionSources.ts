/**
 * THE REFERENCE DECISION'S OWN SOURCES (2026-10-16) - closing the digest hole.
 *
 * Every variant pack (Phase 10 PLO4, Phase 11 PLO5/6/8, Phase 12 Short Deck /
 * Pineapple / FLH / FLO8) deviates from, and otherwise RETURNS, the reference
 * decision HorseLogic builds; the Phase 13 joint owner prices against it. The
 * phase digests hashed HorseLogic.ts itself but none of the modules HorseLogic
 * decides with: the preflop bars, the solver charts and consults, the EV
 * engine, the tournament preflop atlas and Phase 8 owner, the variant
 * profiles, the persona, ICM. A change to any of them changed every qualified
 * pack's live behaviour while every digest stayed the same (investigation
 * 2026-10-16, "DIGEST HOLE"). This list is hashed into all four phase digests
 * (HorsePhase10Authority, HorsePhase11/12/13PolicyDigest), and
 * HorseReferenceDecisionSources.test.ts checks it against HorseLogic's actual
 * runtime imports and their closure, so a new decision import cannot slip
 * past it again.
 *
 * Not hashed itself: it only names paths, and the paths enter every digest.
 */
export const HORSE_REFERENCE_DECISION_SOURCE_REASONS: Readonly<Record<string, string>> =
  Object.freeze({
    'src/services/horseCorrectiveReview/liveKernel.ts':
      'boundary: the Phase 14 worker-local corrective consumer; absent a separately admitted functional capability it preserves action and RNG, and it never stacks on an applied prior candidate',
    'src/engine/HorseRiverNuts.ts':
      'the final river-nuts raise and full-pot near-pot wager invariants after all strategy owners',
    'src/engine/HorseTournamentShoveDiscipline.ts':
      'the final tournament preflop shove-depth wager rule (no deep open or re-raise shove) after all strategy owners',
    'src/engine/HorsePreflop.ts':
      'every preflop bar of the reference (open, 3-bet, 4-bet, call, isolation, push/fold) and the opponent-exploit preflop read',
    'src/engine/HorseTournamentPreflop.ts':
      'the Phase 6 tournament preflop atlas the bars shift by',
    'src/engine/AnteMath.ts': 'the ante orbit cost behind the M-zones',
    'src/engine/OmahaFlushBlocker.ts':
      'physical two-hole three-board nut-flush and straight-flush blockers consumed by the reference decision',
    'src/engine/HorsePloPairedBoardFold.ts':
      'the PLO5/PLO6 paired-board fold applied to the final decision after every other layer (Dan 2026-10-25)',
    'src/engine/HorseOmahaImpliedDraw.ts':
      'physical Omaha draw eligibility for the implied-equity allowance consumed by reference call pricing',
    'src/engine/HorseContinuation.ts':
      'premium identities, stack commitments and funded future-street pricing',
    'src/engine/HorseEvEngine.ts': 'the solverless EV engine (bets, calls, river verdict)',
    'src/engine/GtoCharts.ts': 'the open-jam and big-blind-versus-small-blind jam charts',
    'src/engine/GtoPostflop.ts': 'the heads-up NLH postflop solver consult',
    'src/engine/GtoPostflopV31.ts': 'the V31 solver consult',
    'src/engine/GtoDecisionContext.ts': 'the solver spot context the consults read',
    'src/engine/GtoFacingDefenseV32.ts': 'the facing-bet defense and realization factors',
    'src/engine/GtoBoardRelativeFeaturesV2.ts': 'the board features the V31 consult keys on',
    'src/engine/GtoBoardRelativeFeaturesV1.ts': 'the board features V2 extends',
    'src/gto/SolverPolicyArtifactLoader.ts':
      'loads the solver chart artifact the charts answer from',
    'src/gto/SolverPolicyContract.ts': 'the solver policy contract the artifact is read through',
    'src/gto/SolverStoreIdentity.ts': 'the solver store identity the charts and consults check',
    'src/engine/HorseTournamentPostflop.ts':
      'boundary: the Phase 8 tournament continuation owner HorseLogic invokes and legalizes; its continuation models decide only in Phase 8 candidate mode',
    'src/engine/HorseTournamentUtility.ts':
      'boundary: the Phase 7 tournament utility that chooses the final tournament action; its own imports are the settlement and evidence it prices with',
    'src/engine/HorsePhase8Safety.ts': 'whether the live Phase 8 input is admitted at all',
    'src/engine/HorseVariantProfile.ts':
      'the per-variant style overlays and preflop bar shifts every decision starts from',
    'src/engine/HorsePersona.ts': 'the persona solver adherence the consults honour',
    'src/engine/IcmModel.ts': 'the ICM bubble factor the survival premium uses',
    'src/engine/HorseHandClasses.ts': 'the Omaha hand-class bar shifts',
    'src/engine/pineappleDiscardChoice.ts': 'the Pineapple discard',
    'src/engine/HorseOpponentMemory.ts':
      'durable variant and context keys and validated snapshots used in opponent decisions',
    'src/engine/HorseMindHandIdentity.ts':
      'the original allocated hand coordinate controls which independent public observations a decision may learn',
    'src/engine/HorseDecisionHandBinding.ts':
      'validates original host coordinates and accepted action provenance used by hand-scoped learning',
    'src/engine/HorseObservationWindow.ts':
      'the original public observation time windows that qualify individual read history and cutoff coverage',
    'src/engine/HorseMind.ts':
      'the individual public opponent, self-image, pair and plan reads consumed by every reference decision',
    'src/engine/HorseObserverReadContext.ts':
      'the exact individual, variant, explicit format and dealt-size partition for public observation history',
    'src/engine/horseDecision/ownPublicHistory.ts':
      'the closed individual public-history schema, original availability cutoff, bounded cache and payload acknowledgement',
    'src/engine/horseDecision/observerParticipants.ts':
      'the original validated FAST participant registry and exact same-observer cross-shard completion admission',
    'src/engine/horseDecision/completedHandActions.ts':
      'the canonical public-action projection used by individual historical and live completed-hand learning',
    'src/engine/horseDecision/lane.ts':
      'boundary: actual pool wiring admits original validated observers and propagates public completions only to the same observer; read owners are separately hashed',
    'src/services/HorseOwnPublicHistory.ts':
      'boundary: the individual service-only public reader pins its exact native-qualified database definition, context and bounded query; provider transport is not strategy authority',
    'src/engine/horseDecision/observerReads.ts':
      'the individual observation admission, cutoff, completion and read-state ownership used by FAST decisions',
    'src/engine/horseDecision/client.ts':
      'boundary: the original snapshot capture and transport must never import pooled opponent histories; actual individual read owners are separately hashed',
    'src/engine/horseDecision/workerRuntime.ts':
      'boundary: exact worker wiring selects the individual view, freezes DEEP reads and applies plans to the original observer; strategy and read owners are separately hashed',
    'src/engine/HorsePlanHandIdentity.ts':
      'the original observer and hand identity retained through accepted and recovered decision plans',
    'src/engine/HorsePlanEffectReceipt.ts':
      'the accepted-plan reconstruction that refuses unknown observer contexts before restoring individual intent',
    'src/engine/HorseDecisionEffects.ts':
      'the validation and identity of individual accepted intent writes consumed by future decisions',
    'src/engine/HorseWinnerRead.ts':
      'the proven-winner read that tempers the opponent exploit against a player who beats the game',
    'src/engine/HorseOpponentExploit.ts':
      'the opponent-exploit read, its measured envelope and every effect it has on the reference and the packs',
    'src/engine/BettingStructure.ts':
      'the legal menu and bounds the reference is legalized into (hashed by Phases 11-13; now by Phase 10 too)',
    'src/engine/VariantRules.ts':
      'the card rules the reference reads (hashed by Phases 11-13; now by Phase 10 too)',
  });

export const HORSE_REFERENCE_DECISION_SOURCE_FILES: readonly string[] = Object.freeze(
  Object.keys(HORSE_REFERENCE_DECISION_SOURCE_REASONS)
);

/** Hashed, imports not followed (the reasons above say why). */
export const HORSE_REFERENCE_DECISION_BOUNDARY: readonly string[] = Object.freeze([
  'src/services/horseCorrectiveReview/liveKernel.ts',
  'src/engine/HorseTournamentPostflop.ts',
  'src/engine/HorseTournamentUtility.ts',
  'src/engine/horseDecision/workerRuntime.ts',
  'src/engine/horseDecision/client.ts',
  'src/engine/horseDecision/lane.ts',
  'src/services/HorseOwnPublicHistory.ts',
]);

/**
 * HorseLogic runtime imports, and reference-closure files, that are neither in
 * the list above nor hashed by all four phases, each with the reason it cannot
 * change a reference decision or the digest that already binds it. (A file
 * every phase already hashes needs no entry.)
 */
export const HORSE_REFERENCE_DECISION_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
  'src/services/errorReporter.ts': 'reports a thrown decision; the safety net, not a decision',
  'src/engine/BrainTelemetry.ts': 'fire counters and latency telemetry; no value a decision reads',
  'src/engine/HorsePolicyGraph.ts':
    'runs the owners in order and records what each returned; the decision is each step value',
  'src/engine/HorsePhase6Attribution.ts':
    'the Phase 6 preflop attribution receipt, built after the decision from it',
  'src/engine/HorseReviewSignals.ts': 'review signals are observed and explicitly ignored',
  'src/engine/multiway/JointLivePolicy.ts':
    'the Phase 13 owner: bound by the Phase 13 digest; runs after the variant owners and acts only when Phase 13 is selected',
  'src/engine/multiway/JointSampleAcquisition.ts':
    'the Phase 13 joint sample acquisition: bound by the Phase 13 digest; the variant packs refuse multi-board hands',
  'src/engine/multiway/JointActionModel.ts':
    'the Phase 13 response model: bound by the Phase 13 digest',
  'src/engine/omaha/OmahaVariantLivePolicy.ts':
    'the Phase 11 owner: hashed by Phase 11; the registry routes each variant to exactly one owner',
  'src/engine/omaha/OmahaVariantPolicyPack.ts': 'the Phase 11 packs: hashed by Phase 11 (and 13)',
  'src/engine/remainingVariants/RemainingVariantLivePolicy.ts':
    'the Phase 12 owner: hashed by Phases 12 and 13; the registry routes each variant to exactly one owner',
  'src/engine/remainingVariants/RemainingVariantPolicyPack.ts':
    'the Phase 12 packs: hashed by Phases 12 and 13',
});
