/**
 * Phase 13 runtime policy digest (Horse Brain P13.3), for Phase 13 admission.
 *
 * STUB WRITTEN BY P13.2. The owner of this file is P13.3, whose version
 * replaces this one at merge: it carries the agreed exports with their agreed
 * meaning, so the P13.2 assembler compiles and binds a real digest of the
 * running joint owner, but its file list is the joint owner's own directory
 * plus the node that invokes and legalizes it, not the TypeScript-parser
 * closure (with exclusion reasons) that P13.3 owns and checks.
 *
 * The same construction as Phase 12's `horsePhase12PolicyDigestOf`: sha256
 * over a versioned definition, the variant and the exact bytes of every listed
 * source file. The joint domain, response and range pack versions are string
 * literals inside the hashed files (JointSampleAcquisition.ts,
 * JointActionModel.ts, JointRangeSampler.ts), so their bytes bind them; they
 * are not imported, because JointActionModel.ts reaches the Phase 7 owner,
 * whose import closure constructs the database client at load. One digest per
 * variant: the variant enters the hash, so an NLH qualification can never bind
 * another variant's digest.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN_VARIANTS } from './VariantRules.js';

/** Bump whenever the file list or the hashing below changes. */
export const HORSE_PHASE13_POLICY_DIGEST_DEFINITION = 'horse-phase13-policy-digest-v1';

/** Server-relative source paths whose bytes change a Phase 13 proposal (stub
 * list: the joint owner and the node that invokes, legalizes and guards it). */
export const HORSE_PHASE13_POLICY_SOURCE_FILES: readonly string[] = Object.freeze([
  'src/engine/multiway/DealtSeatCensus.ts',
  'src/engine/multiway/JointActionModel.ts',
  'src/engine/multiway/JointActionShared.ts',
  'src/engine/multiway/JointCardLayout.ts',
  'src/engine/multiway/JointDeductions.ts',
  'src/engine/multiway/JointInputBinding.ts',
  'src/engine/multiway/JointLivePolicy.ts',
  'src/engine/multiway/JointPotDistribution.ts',
  'src/engine/multiway/JointRangeSampler.ts',
  'src/engine/multiway/JointResponseOrder.ts',
  'src/engine/multiway/JointResponseTree.ts',
  'src/engine/multiway/JointSampleAcquisition.ts',
  'src/engine/multiway/JointStreetBetting.ts',
  'src/engine/HorseLogic.ts',
  'src/engine/BettingStructure.ts',
  'src/engine/VariantRules.ts',
  'src/engine/PokerEngine.ts',
  'src/config/rakeSpec.ts',
  'src/config/tableSeating.ts',
]);

/** Reads a server-relative source path. Throws on failure. */
export type HorsePhase13PolicySourceReader = (serverRelativePath: string) => Buffer;

/** The server root in source and test runs (src/engine/../../) and in the
 * engine image (dist/engine/../../ is /app, which holds src/). */
export const runningPhase13PolicySourceReader: HorsePhase13PolicySourceReader = (path) =>
  readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)));

/** sha256 over the definition, the variant and every policy source file (path and exact bytes, in list order). Throws when
 * the variant is unknown or a file is unreadable. */
export function horsePhase13PolicyDigestOf(
  variant: string,
  read: HorsePhase13PolicySourceReader
): string {
  if (!(KNOWN_VARIANTS as readonly string[]).includes(variant))
    throw new Error('Unknown Phase 13 policy variant');
  const hash = createHash('sha256');
  hash.update(`${HORSE_PHASE13_POLICY_DIGEST_DEFINITION}\0${variant}\0`);
  for (const file of HORSE_PHASE13_POLICY_SOURCE_FILES) {
    hash.update(`${file}\0`);
    hash.update(read(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const running = new Map<string, string>();
/** The running code's Phase 13 policy digest for one variant, computed on
 * first use and kept for the process. */
export function horsePhase13PolicyDigest(variant: string): string {
  if (!running.has(variant))
    running.set(variant, horsePhase13PolicyDigestOf(variant, runningPhase13PolicySourceReader));
  return running.get(variant)!;
}
