/**
 * Phase 11 runtime policy digest (Horse Brain P11.2), for P11.3 admission.
 *
 * The same construction as Phase 10's `horsePhase10PolicyDigestOf`
 * (HorsePhase10Authority.ts): sha256 over a versioned definition, the pack
 * version and the exact bytes of every source file that decides the pack's
 * candidate behaviour. The P11.2 assembler records this function's value from
 * the assembling checkout (after proving every hashed file is identical at the
 * runs' head), so a P11.3 admission can recompute it from the running code and
 * refuse a qualification made on different policy code.
 *
 * One digest per pack: the variant and its pack version enter the hash, so a
 * PLO5 qualification can never bind a PLO6 or PLO8 digest. The file list is
 * shared, because the three packs share every file.
 *
 * Deliberately not hashed: the strength contract (bound by its own contract
 * digest) and this file (bound by the definition version below). Nothing here
 * selects, admits or activates anything.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  OMAHA_VARIANT_PACKS,
  isOmahaPolicyVariant,
  type OmahaPolicyVariant,
} from './omaha/OmahaVariantPolicyPack.js';

/** Bump whenever the file list or the hashing below changes. */
export const HORSE_PHASE11_POLICY_DIGEST_DEFINITION = 'horse-phase11-policy-digest-v3';

/**
 * The code that determines Phase 11 candidate behaviour, as server-relative
 * source paths: the packs and their live policy, the variant sampler and its
 * equity summary, the card facts; the shared PLO4 seat/action kernel the live
 * policy imports (Plo4LivePolicy.ts) and the pack constants that kernel reads
 * (Plo4PolicyPack.ts); the HorseLogic owner that invokes the policy and
 * legalizes its proposal, and the registry that routes the variant to it; the
 * evaluator, pot/rake arithmetic, variant rules, dealt-seat census and load
 * governor the policy and sampler call at run time; the tournament utility
 * evidence the kernel imports; and the HorseMind reads and observation windows
 * the reference path and the kernel's imports consume. v2 adds the three
 * value sources v1 left out: the five-card scorer every Omaha showdown score
 * reduces to (HorseFiveCardScore.ts), the rake specification the pot
 * arithmetic charges (config/rakeSpec.ts), and the seating tables the live
 * policy reads positions from (config/tableSeating.ts). v3 (audit 2026-10-05)
 * adds the betting-structure rules (BettingStructure.ts) that decide whether
 * HorseLogic legalizes a proposal as pot limit, which the candidate's legal form
 * and the `illegal_candidate` guard depend on.
 */
export const HORSE_PHASE11_POLICY_SOURCE_FILES: readonly string[] = Object.freeze([
  'src/engine/omaha/OmahaVariantPolicyPack.ts',
  'src/engine/omaha/OmahaVariantLivePolicy.ts',
  'src/engine/omaha/OmahaVariantSampler.ts',
  'src/engine/omaha/OmahaVariantEquity.ts',
  'src/engine/omaha/OmahaCardFacts.ts',
  'src/engine/plo4/Plo4LivePolicy.ts',
  'src/engine/plo4/Plo4PolicyPack.ts',
  'src/engine/HorseLogic.ts',
  'src/engine/HorsePolicyRegistry.ts',
  'src/engine/HorseEval.ts',
  'src/engine/PokerEngine.ts',
  'src/engine/VariantRules.ts',
  'src/engine/multiway/DealtSeatCensus.ts',
  'src/engine/EquityLoadGovernor.ts',
  'src/engine/HorseTournamentUtilityEvidence.ts',
  'src/engine/HorseObservationWindow.ts',
  'src/engine/HorseMind.ts',
  'src/engine/HorseFiveCardScore.ts',
  'src/config/rakeSpec.ts',
  'src/config/tableSeating.ts',
  'src/engine/BettingStructure.ts',
]);

/**
 * Runtime import-closure files of the live policy, the sampler and the packs
 * that are deliberately NOT hashed, each with the reason it cannot change a
 * Phase 11 candidate decision or its legal form (audit 2026-10-07). The list
 * is checked against the actual closure in HorsePhase11PolicyDigest.test.ts,
 * so a new runtime import fails there until it is hashed or named here: the
 * file list can no longer drift from the code it is meant to bind.
 */
export const HORSE_PHASE11_POLICY_EXCLUDED_CLOSURE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    'src/engine/CryptoRandom.ts':
      'the physical deck shuffle of a live hand (PokerEngine.Deck); no policy or sampler call reads it, the sampler uses the HorseEval fast random stream',
    'src/engine/HorseTournamentContinuation.ts':
      'imported by HorseEval for the Phase 8 tournament continuation capture (captureContinuation), which no Phase 11 policy or sampler call requests',
    'src/engine/HorseDecisionEffects.ts':
      'HorseMind decision-effect bookkeeping; it holds no value a Phase 11 decision reads',
    'src/engine/HorseMindHandIdentity.ts':
      'HorseMind hand-identity binding; it holds no value a Phase 11 decision reads',
    'src/engine/HorsePlanHandIdentity.ts':
      'HorseMind plan hand-identity binding; it holds no value a Phase 11 decision reads',
    'src/engine/HorseDecisionHandBinding.ts':
      'hand-binding records under the identities above; it holds no value a Phase 11 decision reads',
  });

/** Reads a server-relative source path. Throws on failure. */
export type HorsePhase11PolicySourceReader = (serverRelativePath: string) => Buffer;

/** The server root in source and test runs (src/engine/../../) and in the
 * engine image (dist/engine/../../ is /app, which holds src/). */
export const runningPhase11PolicySourceReader: HorsePhase11PolicySourceReader = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

/** sha256 over the definition, the variant, its pack version and every policy
 * source file (path and exact bytes, in list order). Null when the variant is
 * not a Phase 11 pack or any file is unreadable. */
export function horsePhase11PolicyDigestOf(
  variant: OmahaPolicyVariant,
  read: HorsePhase11PolicySourceReader
): string | null {
  if (!isOmahaPolicyVariant(variant)) return null;
  const hash = createHash('sha256');
  hash.update(
    `${HORSE_PHASE11_POLICY_DIGEST_DEFINITION}\0${variant}\0${OMAHA_VARIANT_PACKS[variant].version}\0`
  );
  try {
    for (const file of HORSE_PHASE11_POLICY_SOURCE_FILES) {
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

const running = new Map<OmahaPolicyVariant, string | null>();
/** The running code's Phase 11 policy digest for one pack, computed on first
 * use and kept for the process. */
export function horsePhase11PolicyDigest(variant: OmahaPolicyVariant): string | null {
  if (!running.has(variant))
    running.set(variant, horsePhase11PolicyDigestOf(variant, runningPhase11PolicySourceReader));
  return running.get(variant) ?? null;
}
