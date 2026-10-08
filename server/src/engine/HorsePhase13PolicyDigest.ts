/**
 * Phase 13 runtime policy digest (Horse Brain P13.3), for Phase 13 admission.
 *
 * The same construction as `horsePhase12PolicyDigestOf`: sha256 over a
 * versioned definition, the variant, the joint identities (domain, range pack,
 * response pack) and the exact bytes of every source file that can change a
 * Phase 13 joint proposal for that variant, or whether that proposal may act.
 * The P13.2 assembler records this function's value; admission recomputes it
 * from the running code and refuses a qualification made on different policy
 * code.
 *
 * What a proposal is here. The joint owner runs after the variant owners: its
 * baseline is the decision the Phase 10, 11 or 12 pack (or the reference
 * path) already produced. The digest therefore covers the files that change
 * the joint PROPOSAL given that baseline, and the files that decide whether
 * the proposal may act (the legalizer and its guards in HorseLogic, the legal
 * menu in BettingStructure and VariantRules, and the input binding the worker
 * boundary validates before an applied receipt is accepted). It does not cover
 * the variant owners' own decision code: a change there changes the baseline,
 * which the matrix supplies to both arms alike.
 *
 * One digest per variant: the variant enters the hash, so an NLH qualification
 * can never bind a PLO4 digest. The file list is shared, because every variant
 * runs the same joint owner.
 *
 * Deliberately not hashed: the strength contract (bound by its own contract
 * digest) and this file (bound by the definition version below). Nothing here
 * selects, admits or activates anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JOINT_LIVE_DOMAIN } from './multiway/JointSampleAcquisition.js';
import { JOINT_RANGE_PACK } from './multiway/JointRangeSampler.js';
import { JOINT_ACTION_PACK } from './multiway/JointActionModel.js';
import { isJointVariant, type JointVariant } from './multiway/JointInputBinding.js';

/** Bump whenever the file list or the hashing below changes. */
export const HORSE_PHASE13_POLICY_DIGEST_DEFINITION = 'horse-phase13-policy-digest-v1';

/**
 * The code that determines a Phase 13 joint proposal, as server-relative
 * source paths, each with the reason it is hashed. Derived from the
 * transitive RUNTIME import closure of every non-test owner under
 * `src/engine/multiway/` (type-only imports excluded), with the boundaries in
 * HORSE_PHASE13_POLICY_BOUNDARY (whose own imports are not followed), plus the
 * owner that invokes and legalizes the policy (HorseLogic.ts) and the registry
 * that routes every variant through the policy graph. Every closure file that
 * can change a joint proposal, its legal form, or whether it may act is here;
 * the closure files left out are in HORSE_PHASE13_POLICY_EXCLUDED_CLOSURE_FILES
 * with the reason each cannot.
 */
export const HORSE_PHASE13_POLICY_SOURCE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'src/engine/multiway/JointLivePolicy.ts':
    'the live wrapper: modes, the 4 ms work check, the legal-form rebuild of candidates, the paired-edge selection rule, the receipt and its validator',
  'src/engine/multiway/JointSampleAcquisition.ts':
    'JOINT_LIVE_DOMAIN (domain version, sample counts, the 4 ms and 2.5 ms budgets, depth ceilings) and every eligibility refusal',
  'src/engine/multiway/JointRangeSampler.ts':
    'the joint public-range sampler: the range pack, priors, rejection and uniform escape',
  'src/engine/multiway/JointCardLayout.ts':
    'the physical card layout every joint sample is dealt from (one to three boards, bomb hands)',
  'src/engine/multiway/DealtSeatCensus.ts': 'the dealt-seat census of live, folded and away seats',
  'src/engine/multiway/JointActionModel.ts':
    'the response pack identities, the dispatch between the round 1 and current models and the paired comparison with the baseline',
  'src/engine/multiway/JointActionShared.ts':
    'candidate construction, the legal-form hook, players behind and the one-response computation',
  'src/engine/multiway/JointResponseTree.ts':
    'the bounded raise tree: raise share, hero answer, the river round and the branch limits',
  'src/engine/multiway/JointResponseCalibration.ts':
    'the measured population response pack: continue and raise frequencies by variant and street, and the strength-percentile order of who responds',
  'src/engine/multiway/JointStreetBetting.ts':
    'the controller replica that sizes the one bounded raise and decides reopening and caps',
  'src/engine/multiway/JointResponseOrder.ts':
    'the controller action order from the posted blinds, which decides who responds after the hero',
  'src/engine/multiway/JointPotDistribution.ts':
    'main and side pot preparation and per-sample settlement of every priced branch',
  'src/engine/multiway/JointDeductions.ts':
    'rake and jackpot deductions applied to every priced branch',
  'src/engine/multiway/JointInputBinding.ts':
    'the input binding the worker boundary validates; an invalid binding refuses an applied receipt',
  'src/engine/HorseLogic.ts':
    'the owner: builds the baseline, invokes the joint policy with its legalizer, applies the illegal_candidate and earlier_phase_applied guards and the Phase 7 tournament owner',
  'src/engine/HorsePolicyRegistry.ts':
    'routes every variant to its owner (multi-board hands to Phase 13) and defines the ownership record the worker boundary checks on every joint decision',
  'src/engine/WinnerUnitScaling.ts':
    "scaleWinnerCentsForRake and scaleMultiBoardWinnerUnits, HandController's own pot scaling after rake, which settles every priced branch (JointDeductions)",
  'src/engine/HorseTournamentUtility.ts':
    'boundary: buildTournamentActionCandidates builds every joint candidate and every bounded raise; its own imports are not followed because that function reads none of them and the rest of the file is the Phase 7 tournament owner, which never prices a cash proposal',
  'src/engine/PokerEngine.ts':
    'calculateContestablePot, calculatePots, calculateRake, calculateBettingState, validateAction and the card tables',
  'src/engine/BettingStructure.ts':
    'the structure of each variant, pot-limit and fixed-limit bounds, the legal menu the candidates come from',
  'src/engine/VariantRules.ts': 'hole cards, split-low rules, deck and seat ceilings per variant',
  'src/engine/HorseEval.ts': 'the scorers and the fast random stream the sampler draws from',
  'src/engine/HorseFiveCardScore.ts': 'the five-card scorer every high score reduces to',
  'src/engine/EquityLoadGovernor.ts':
    'the governor scale that sets the requested sample count under load',
  'src/config/rakeSpec.ts': 'the rake arithmetic every deduction charges',
  'src/config/tableSeating.ts': 'the cash seat ceilings the acquisition refuses above',
  'src/engine/plo4/Plo4LivePolicy.ts':
    'plo4BlindSeatsStatus and plo4ButtonOffset: the posted-blind check and button offset behind the action order and the binding',
  'src/engine/plo4/Plo4PolicyPack.ts': 'plo4HandShape, the PLO4 range prior the sampler reads',
  'src/engine/omaha/OmahaVariantPolicyPack.ts':
    'omahaVariantHandShape, the PLO5/PLO6/PLO8 range prior the sampler reads',
  'src/engine/remainingVariants/RemainingVariantPolicyPack.ts':
    'remainingVariantHandShape (the Short Deck, Pineapple, FLH and FLO8 range priors) and the fixed-limit depth ceiling JOINT_LIVE_DOMAIN reads',
  'src/engine/remainingVariants/RemainingVariantSampler.ts':
    'choosePineappleFlopPair, the Pineapple retained pair every joint Pineapple sample uses',
  'src/engine/remainingVariants/RemainingVariantLivePolicy.ts':
    'remainingVariantChipUnit: the legal chip step the binding records and the boundary validator recomputes',
  'src/engine/HorseTournamentUtilityEvidence.ts':
    'horseCanonicalMaterialSha256, the binding commitment the witness carries and the reviewer recomputes',
});

/**
 * Hashed boundaries whose imports are not followed (reasons above), and
 * excluded boundaries whose imports are not followed (reasons below).
 */
export const HORSE_PHASE13_POLICY_BOUNDARY: readonly string[] = Object.freeze([
  'src/engine/HorseTournamentUtility.ts',
  'src/engine/horseDecision/protocol.ts',
  'src/engine/remainingVariants/RemainingVariantActionEconomics.ts',
]);

export const HORSE_PHASE13_POLICY_SOURCE_FILES: readonly string[] = Object.freeze(
  Object.keys(HORSE_PHASE13_POLICY_SOURCE_REASONS)
);

/** Runtime closure files deliberately not hashed, with the reason each cannot
 * change a Phase 13 proposal, its legal form, or whether it may act. */
export const HORSE_PHASE13_POLICY_EXCLUDED_CLOSURE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    'src/engine/horseDecision/protocol.ts':
      'boundary: buildHorseDecisionKey only names the decision state (the receipt stateKey and the acquisition binding); it seeds nothing, and the worker has already refused a non-canonical request before any decision; the rest of the file is the worker transport',
    'src/engine/remainingVariants/RemainingVariantActionEconomics.ts':
      'boundary: the Phase 12 post-decision net-action economics; no joint call reaches it',
    'src/engine/omaha/OmahaVariantEquity.ts':
      'the Phase 11 and 12 equity summaries; neither choosePineappleFlopPair nor remainingVariantChipUnit calls it',
    'src/engine/omaha/OmahaCardFacts.ts':
      'the Phase 10 card facts the PLO4 policy reads; plo4BlindSeatsStatus and plo4ButtonOffset read nothing from it',
    'src/engine/HorseObservationWindow.ts':
      'observation windows of the Phase 10 policy and the Phase 7 evidence; no joint call reads them',
    'src/engine/HorseMind.ts':
      'the reads the reference path consumes; the joint proposal is computed against the baseline it is given and calls nothing in it',
    'src/engine/CryptoRandom.ts':
      'the physical deck shuffle of a live hand (PokerEngine.Deck); the sampler uses the HorseEval fast random stream',
    'src/engine/HorseTournamentContinuation.ts':
      'imported by HorseEval for the Phase 8 tournament continuation capture, which no joint call requests',
    'src/engine/HorseDecisionEffects.ts':
      'HorseMind decision-effect bookkeeping; it holds no value a joint proposal reads',
    'src/engine/HorseMindHandIdentity.ts':
      'HorseMind hand-identity binding; it holds no value a joint proposal reads',
    'src/engine/HorsePlanHandIdentity.ts':
      'HorseMind plan hand-identity binding; it holds no value a joint proposal reads',
    'src/engine/HorseDecisionHandBinding.ts':
      'hand-binding records under the identities above; it holds no value a joint proposal reads',
  });

/** Reads a server-relative source path. Throws on failure. */
export type HorsePhase13PolicySourceReader = (serverRelativePath: string) => Buffer;

/** The server root in source and test runs (src/engine/../../) and in the
 * engine image (dist/engine/../../ is /app, which holds src/). */
export const runningPhase13PolicySourceReader: HorsePhase13PolicySourceReader = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

/** sha256 over the definition, the variant, the joint identities and every
 * policy source file (path and exact bytes, in list order). Null when the
 * variant is not a joint variant or any file is unreadable. */
export function horsePhase13PolicyDigestOf(
  variant: JointVariant,
  read: HorsePhase13PolicySourceReader
): string | null {
  if (!isJointVariant(variant)) return null;
  const hash = createHash('sha256');
  hash.update(
    `${HORSE_PHASE13_POLICY_DIGEST_DEFINITION}\0${variant}\0${JOINT_LIVE_DOMAIN.version}\0${JOINT_RANGE_PACK.version}\0${JOINT_ACTION_PACK.version}\0`
  );
  try {
    for (const file of HORSE_PHASE13_POLICY_SOURCE_FILES) {
      const bytes = read(file);
      hash.update(`${file}\0`);
      hash.update(bytes);
      hash.update('\0');
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
}

const running = new Map<JointVariant, string | null>();
/** The running code's Phase 13 policy digest for one variant, computed on
 * first use and kept for the process. */
export function horsePhase13PolicyDigest(variant: JointVariant): string | null {
  if (!running.has(variant))
    running.set(variant, horsePhase13PolicyDigestOf(variant, runningPhase13PolicySourceReader));
  return running.get(variant) ?? null;
}
