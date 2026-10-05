/**
 * Phase 12 runtime policy digest (Horse Brain P12.2), for P12.3 admission.
 *
 * The same construction as Phase 11's `horsePhase11PolicyDigestOf`
 * (HorsePhase11PolicyDigest.ts): sha256 over a versioned definition, the
 * variant, its pack version and the exact bytes of every source file that can
 * change the pack's candidate decision or its legal form. The P12.2 assembler
 * records this function's value from the assembling checkout (after proving
 * every hashed file identical at the runs' head), so a P12.3 admission can
 * recompute it from the running code and refuse a qualification made on
 * different policy code.
 *
 * One digest per pack: the variant and its pack version enter the hash, so a
 * Short Deck qualification can never bind a Pineapple, FLH or FLO8 digest. The
 * file list is shared, because the four packs share every file.
 *
 * Deliberately not hashed: the strength contract (bound by its own contract
 * digest) and this file (bound by the definition version below). Nothing here
 * selects, admits or activates anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REMAINING_VARIANT_PACKS,
  isRemainingPolicyVariant,
  type RemainingPolicyVariant,
} from './remainingVariants/RemainingVariantPolicyPack.js';

/** Bump whenever the file list or the hashing below changes. */
export const HORSE_PHASE12_POLICY_DIGEST_DEFINITION = 'horse-phase12-policy-digest-v1';

/**
 * The code that determines Phase 12 candidate behaviour, as server-relative
 * source paths, each with the reason it is hashed. The list was derived from
 * the transitive RUNTIME import closure of RemainingVariantLivePolicy.ts,
 * RemainingVariantSampler.ts and RemainingVariantPolicyPack.ts (type-only
 * imports excluded; 26 files), plus the owner that invokes and legalizes the
 * policy (HorseLogic.ts) and the registry that routes a variant to it.
 * Every closure file that can change a candidate decision or its legal form
 * is here; the closure files left out are in
 * HORSE_PHASE12_POLICY_EXCLUDED_CLOSURE_FILES with the reason each cannot.
 */
export const HORSE_PHASE12_POLICY_SOURCE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'src/engine/remainingVariants/RemainingVariantPolicyPack.ts':
    'the four packs: versions, entry bars, hand shapes, seat caps and the live budgets',
  'src/engine/remainingVariants/RemainingVariantLivePolicy.ts':
    'the live policy: eligibility, geometry, thresholds, fixed-limit sizing and the proposal',
  'src/engine/remainingVariants/RemainingVariantSampler.ts':
    'the bounded equity sampler: public-line prior, Pineapple flop-only discard prior, deadline',
  'src/engine/omaha/OmahaVariantEquity.ts':
    'the equity summary the sampler returns and the validity check the policy applies to it',
  'src/engine/omaha/OmahaCardFacts.ts':
    'the exact FLO8 card facts (nut low, counterfeit, quartering) the policy reads before sampling',
  'src/engine/plo4/Plo4LivePolicy.ts':
    'the shared seat/role kernel: plo4Position, plo4Role and plo4PreflopChoice',
  'src/engine/plo4/Plo4PolicyPack.ts': 'the position and role constants the kernel reads',
  'src/engine/HorseLogic.ts':
    'the owner: builds the reference, invokes the policy, legalizes its proposal, applies the illegal_candidate guard and the Phase 7 tournament owner',
  'src/engine/HorsePolicyRegistry.ts': 'routes each Phase 12 variant to the Phase 12 owner',
  'src/engine/HorseEval.ts':
    'the scorers the sampler calls (scoreHoldem, scoreOmahaHi, scoreOmahaLow), the fast random stream, nlhNutStatus and the structural caps behind the decision equity ceiling',
  'src/engine/HorseFiveCardScore.ts':
    'the five-card scorer every Short Deck, Pineapple, FLH and FLO8 high score reduces to',
  'src/engine/PokerEngine.ts':
    'calculateContestablePot and calculateRake (net call price), the rank and suit tables the sampler deals from',
  'src/engine/BettingStructure.ts':
    'fixedLimitStreetBounds: the fixed-limit raise size, short completion and wager count the proposal uses',
  'src/engine/VariantRules.ts': 'card rules and the variant seat ceiling the pack reads',
  'src/engine/multiway/DealtSeatCensus.ts':
    'the dealt-seat census the policy and sampler use for live and folded seats',
  'src/engine/EquityLoadGovernor.ts': 'the live sample scale the sampler applies',
  'src/engine/HorseTournamentUtilityEvidence.ts':
    'tournament utility evidence the kernel imports and the Phase 7 owner reads',
  'src/engine/HorseObservationWindow.ts':
    'observation windows the kernel and the tournament evidence normalize',
  'src/engine/HorseMind.ts':
    'the reads the reference path consumes; the candidate falls back to that reference wherever it does not fire',
  'src/config/rakeSpec.ts': 'the rake arithmetic the net call price charges',
  'src/config/tableSeating.ts': 'the cash seat ceilings remainingVariantSeatCap reads',
  'src/engine/remainingVariants/RemainingVariantActionEconomics.ts':
    'the P12-B net-action economics priced after the decision on the FLH/FLO8 river, and the validator the worker boundary applies to them (an invalid applied receipt fails closed)',
});

/**
 * Hashed, but its own imports are not followed: the P12-B net-action
 * economics run strictly after the policy has fixed its reason, proposal and
 * latency, and nothing reads their result to decide. Their settlement imports
 * (the joint pot and deduction owners) can change the diagnostic numbers, never
 * a candidate decision or its legal form.
 */
export const HORSE_PHASE12_POLICY_DIAGNOSTIC_BOUNDARY: readonly string[] = Object.freeze([
  'src/engine/remainingVariants/RemainingVariantActionEconomics.ts',
]);
export const HORSE_PHASE12_POLICY_SOURCE_FILES: readonly string[] = Object.freeze(
  Object.keys(HORSE_PHASE12_POLICY_SOURCE_REASONS)
);

/** Runtime closure files deliberately not hashed, with the reason each cannot
 * change a Phase 12 candidate decision or its legal form. */
export const HORSE_PHASE12_POLICY_EXCLUDED_CLOSURE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    'src/engine/omaha/OmahaVariantPolicyPack.ts':
      'imported by OmahaVariantEquity only for isOmahaPolicyVariant, which gates the Phase 11 entry (omahaVariantEquity); the Phase 12 sampler calls variantEquityFromShowdowns directly, and the registry reads only Phase 11 pack versions from it',
    'src/engine/CryptoRandom.ts':
      'the physical deck shuffle of a live hand (PokerEngine.Deck); no policy or sampler call reads it, the sampler uses the HorseEval fast random stream',
    'src/engine/HorseTournamentContinuation.ts':
      'imported by HorseEval for the Phase 8 tournament continuation capture (captureContinuation), which no Phase 12 policy or sampler call requests',
    'src/engine/HorseDecisionEffects.ts':
      'HorseMind decision-effect bookkeeping; it holds no value a Phase 12 decision reads',
    'src/engine/HorseMindHandIdentity.ts':
      'HorseMind hand-identity binding; it holds no value a Phase 12 decision reads',
    'src/engine/HorsePlanHandIdentity.ts':
      'HorseMind plan hand-identity binding; it holds no value a Phase 12 decision reads',
    'src/engine/HorseDecisionHandBinding.ts':
      'hand-binding records under the identities above; it holds no value a Phase 12 decision reads',
  });

/** Reads a server-relative source path. Throws on failure. */
export type HorsePhase12PolicySourceReader = (serverRelativePath: string) => Buffer;

/** The server root in source and test runs (src/engine/../../) and in the
 * engine image (dist/engine/../../ is /app, which holds src/). */
export const runningPhase12PolicySourceReader: HorsePhase12PolicySourceReader = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

/** sha256 over the definition, the variant, its pack version and every policy
 * source file (path and exact bytes, in list order). Null when the variant is
 * not a Phase 12 pack or any file is unreadable. */
export function horsePhase12PolicyDigestOf(
  variant: RemainingPolicyVariant,
  read: HorsePhase12PolicySourceReader
): string | null {
  if (!isRemainingPolicyVariant(variant)) return null;
  const hash = createHash('sha256');
  hash.update(
    `${HORSE_PHASE12_POLICY_DIGEST_DEFINITION}\0${variant}\0${REMAINING_VARIANT_PACKS[variant].version}\0`
  );
  try {
    for (const file of HORSE_PHASE12_POLICY_SOURCE_FILES) {
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

const running = new Map<RemainingPolicyVariant, string | null>();
/** The running code's Phase 12 policy digest for one pack, computed on first
 * use and kept for the process. */
export function horsePhase12PolicyDigest(variant: RemainingPolicyVariant): string | null {
  if (!running.has(variant))
    running.set(variant, horsePhase12PolicyDigestOf(variant, runningPhase12PolicySourceReader));
  return running.get(variant) ?? null;
}
