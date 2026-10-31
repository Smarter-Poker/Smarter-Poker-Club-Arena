import { featureLiveDomainRefusals } from './HorseFeatureLiveDomain.js';
/** Feature promotion reuses the generation-bound holder/gate. Measurement
 * reports remain inactive; only a protected, shipped selection can admit one.
 * There are deliberately no selected features in the current release. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HORSE_REFERENCE_DECISION_SOURCE_FILES } from './HorseReferenceDecisionSources.js';
import { fileURLToPath } from 'node:url';
import {
  canonical,
  HorsePhase8AuthorityGate,
  releaseEvidenceReader,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
  type HorseAuthorityReceipt,
  type HorseQualifiedAuthority,
} from './HorseQualifiedAuthority.js';
import type { HorseDecision } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';

export const HORSE_FEATURE_AUTHORITY_VERSION = 'horse-feature-promotion-v1';
export const HORSE_FEATURE_FLAGS = [
  'comboDrawPressure',
  'v54RiverBluff',
  'riverPositionDefense',
  'riverBluffCheckRaise',
  'barrelContinuationOutlook',
  'smallPotNearNutRiverValue',
  'multiwayRiverBluffCheckRaise',
] as const;
export type HorseFeatureFlag = (typeof HORSE_FEATURE_FLAGS)[number];
export type HorseFeatureFlags = Record<HorseFeatureFlag, boolean>;
const off = (): HorseFeatureFlags =>
  Object.fromEntries(HORSE_FEATURE_FLAGS.map((k) => [k, false])) as HorseFeatureFlags;
const hash = (x: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(x)))
    .digest('hex');
const bytesHash = (x: Buffer) => createHash('sha256').update(x).digest('hex');
const hex = (x: unknown, n: number) =>
  typeof x === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(x);
const safePath = (x: unknown): x is string =>
  typeof x === 'string' && /^docs\/evidence\/feature-activation\/[a-zA-Z0-9_.-]+\.json$/.test(x);
export interface HorseFeatureDomain {
  variant: 'nlh' | 'plo4' | 'plo5' | 'plo6';
  mode: 'cash';
  asset: 'chips' | 'diamonds';
  boardCount: 1;
  dealtSeats: number[];
  remainingPlayers: number[];
  effectiveStackBB: [number, number];
  startingStackBB: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  bigBlindAnte: boolean;
  bettingStructure: 'no_limit' | 'pot_limit';
  chipUnit: 0.01 | 1;
  rakeConfig: NonNullable<HorseGameStateV2['rakeConfig']>;
  bbjConfig: NonNullable<HorseGameStateV2['bbjConfig']> | null;
  sidePots: false;
}
export interface HorseFeatureSelection {
  schema: 'horse-feature-release-selection-v1';
  qualificationPath: string;
  qualificationSha256: string;
  sourceSha: string;
  approvalGeneration: number;
  issuedAt: string;
  expiresAt: string;
  withdrawn: { at: string; reason: string } | null;
}
export interface HorseFeatureDecisionReceipt {
  version: 'horse-feature-decision-v1';
  authority: HorseAuthorityReceipt;
  compositionDigest: string;
  flags: HorseFeatureFlags;
  domain: HorseFeatureDomain;
}
export const HORSE_FEATURE_SELECTION_PATH = 'docs/evidence/feature-activation/selection.json';
/** No runtime writer. The existing immutable release image ships this reviewed
 * selection and its evidence. Missing current selection means unselected. */
export function admitHorseFeatureReleaseAuthority(): HorseAuthorityAdmission {
  let selection: HorseFeatureSelection | null;
  try {
    selection = JSON.parse(releaseEvidenceReader.read(HORSE_FEATURE_SELECTION_PATH).toString());
  } catch {
    return { status: 'refused', reason: 'unselected', transient: false };
  }
  return admitHorseFeatureAuthority(selection);
}

/** Admits the maintained assembler condition(a) artifact. Human-calibrated
 * condition(b) is monitoring/withdrawal only under the October 9 amendment.
 * DEV output and absent locked declarations never grant authority. */
export function admitHorseFeatureAuthority(
  selection: HorseFeatureSelection | null,
  reader: HorseAuthorityEvidenceReader = releaseEvidenceReader,
  now = Date.now(),
  readSource: (p: string) => Buffer = (p) =>
    readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url))),
  sourcePaths: () => string[] = runningFeatureSourcePaths
): HorseAuthorityAdmission {
  const refuse = (
    reason:
      | 'invalid_selection'
      | 'missing_evidence'
      | 'hash_mismatch'
      | 'evidence_mismatch'
      | 'not_qualified'
      | 'source_mismatch'
      | 'policy_digest_mismatch'
      | 'expired'
      | 'unselected'
  ): HorseAuthorityAdmission => ({ status: 'refused', reason, transient: false });
  if (!selection) return refuse('unselected');
  if (
    selection.schema !== 'horse-feature-release-selection-v1' ||
    !safePath(selection.qualificationPath) ||
    !hex(selection.qualificationSha256, 64) ||
    !hex(selection.sourceSha, 40) ||
    !Number.isSafeInteger(selection.approvalGeneration) ||
    selection.approvalGeneration < 1 ||
    !Number.isFinite(Date.parse(selection.issuedAt)) ||
    !Number.isFinite(Date.parse(selection.expiresAt)) ||
    Date.parse(selection.expiresAt) <= Date.parse(selection.issuedAt)
  )
    return refuse('invalid_selection');
  if (selection.withdrawn)
    return {
      status: 'withdrawn',
      approvalGeneration: selection.approvalGeneration,
      reason: selection.withdrawn.reason,
    };
  if (now < Date.parse(selection.issuedAt) || now >= Date.parse(selection.expiresAt))
    return refuse('expired');
  try {
    const bytes = reader.read(selection.qualificationPath);
    if (bytesHash(bytes) !== selection.qualificationSha256) return refuse('hash_mismatch');
    const q = JSON.parse(bytes.toString());
    if (
      q.schema !== 'horse-feature-live-admission-v1' ||
      q.version !== HORSE_FEATURE_AUTHORITY_VERSION ||
      q.qualificationKind !== 'locked_paired_condition_a' ||
      q.qualified !== true ||
      q.activationAllowed !== false ||
      !Array.isArray(q.reasons) ||
      q.reasons.length
    )
      return refuse('not_qualified');
    if (q.sourceSha !== selection.sourceSha) return refuse('source_mismatch');
    const readBound = (binding: { path: string; sha256: string }) => {
      if (!binding || !safePath(binding.path) || !hex(binding.sha256, 64)) throw Error('binding');
      const b = reader.read(binding.path);
      if (bytesHash(b) !== binding.sha256) throw Error('hash');
      return JSON.parse(b.toString());
    };
    const assembly = readBound(q.assembly),
      plan = readBound(q.plan);
    if (
      assembly.schema !== 'horse-feature-ablation-assembly-v1' ||
      assembly.qualified !== true ||
      assembly.activationAllowed !== false ||
      !Array.isArray(assembly.reasons) ||
      assembly.reasons.length ||
      assembly.sourceSha !== q.sourceSha ||
      assembly.planDigest !== hash(plan) ||
      assembly.target !== plan.target ||
      assembly.summary?.qualified !== true ||
      assembly.summary?.activationAllowed !== false ||
      assembly.summary?.planDigest !== assembly.planDigest ||
      !assembly.provider?.rawArtifactsRetained ||
      !hex(assembly.provider?.inventorySha256, 64)
    )
      return refuse('evidence_mismatch');
    if (
      featureLiveDomainRefusals(plan).length ||
      q.profileId !== plan.liveAdmission.profileId ||
      hash(q.domain) !== hash(plan.liveAdmission.domain)
    )
      return refuse('evidence_mismatch');
    const d = q.domain as HorseFeatureDomain;
    if (
      !d ||
      !['nlh', 'plo4', 'plo5', 'plo6'].includes(d.variant) ||
      d.mode !== 'cash' ||
      !['chips', 'diamonds'].includes(d.asset) ||
      d.boardCount !== 1 ||
      !Array.isArray(d.dealtSeats) ||
      !d.dealtSeats.length ||
      d.dealtSeats.some((n) => !Number.isInteger(n) || n < 2 || n > 9) ||
      new Set(d.dealtSeats).size !== d.dealtSeats.length ||
      !Array.isArray(d.effectiveStackBB) ||
      d.effectiveStackBB.length !== 2 ||
      !d.effectiveStackBB.every(Number.isFinite) ||
      d.effectiveStackBB[0] < 0 ||
      d.effectiveStackBB[1] < d.effectiveStackBB[0] ||
      !validFeatureEconomics(d) ||
      assembly.summary.byVariant?.[d.variant]?.qualified !== true
    )
      return refuse('evidence_mismatch');
    const candidate = plan.flags?.candidate,
      reference = plan.flags?.reference;
    if (
      !candidate ||
      !reference ||
      !Object.keys(candidate).length ||
      Object.keys(candidate).some(
        (k) => !HORSE_FEATURE_FLAGS.includes(k as HorseFeatureFlag) || candidate[k] !== true
      ) ||
      hash(Object.keys(candidate).sort()) !== hash(Object.keys(reference).sort()) ||
      Object.entries(reference).some(
        ([k, v]) =>
          v !== (plan.target === 'multiway_river_bluff_checkraise' && k === 'riverBluffCheckRaise')
      ) ||
      q.compositionDigest !== hash(plan.flags)
    )
      return refuse('evidence_mismatch');
    const targets: Record<string, readonly string[]> = {
      combo_draw_pressure: ['comboDrawPressure'],
      targeted_river_bluff: ['v54RiverBluff'],
      river_position_defense: ['riverPositionDefense'],
      river_bluff_checkraise: ['riverBluffCheckRaise'],
      barrel_continuation_outlook: ['barrelContinuationOutlook'],
      pressure_package: HORSE_FEATURE_FLAGS.slice(0, 5),
      small_pot_near_nut_value_raise: ['smallPotNearNutRiverValue'],
      multiway_river_bluff_checkraise: ['riverBluffCheckRaise', 'multiwayRiverBluffCheckRaise'],
    };
    // Only an exact maintained target composition may be selected; DEV cannot promote it.
    if (
      !targets[plan.target] ||
      hash([...targets[plan.target]].sort()) !== hash(Object.keys(candidate).sort())
    )
      return refuse('not_qualified');
    if (
      !hex(plan.dependencyDigest, 64) ||
      bytesHash(readSource('package-lock.json')) !== plan.dependencyDigest
    )
      return refuse('policy_digest_mismatch');
    const files = plan.runtimeSourceFiles;
    if (
      !files ||
      !Object.keys(files).length ||
      !files['src/engine/HorseFeatureAuthority.ts'] ||
      !files['src/engine/HorseLogic.ts'] ||
      !files['src/engine/horseDecision/workerRuntime.ts'] ||
      !files['src/engine/horseDecision/client.ts'] ||
      !hex(plan.runtimeSourceDigest, 64) ||
      hash(files) !== plan.runtimeSourceDigest
    )
      return refuse('policy_digest_mismatch');
    if (sourcePaths().some((p) => !Object.prototype.hasOwnProperty.call(files, p)))
      return refuse('policy_digest_mismatch');
    for (const [p, h] of Object.entries(files)) {
      if (
        (!/^src\/[A-Za-z0-9_./-]+\.(ts|json)$/.test(p) &&
          !HORSE_REFERENCE_DECISION_SOURCE_FILES.includes(p)) ||
        p.includes('..') ||
        !hex(h, 64) ||
        bytesHash(readSource(p)) !== h
      )
        return refuse('policy_digest_mismatch');
    }
    const identity = {
      schema: 'horse-qualified-authority-v1' as const,
      phase: 'features' as const,
      sourceSha: q.sourceSha,
      continuationVersion: HORSE_FEATURE_AUTHORITY_VERSION,
      policyDigest: plan.runtimeSourceDigest,
      packId: plan.target,
      domain: hash(d),
      evidencePath: selection.qualificationPath,
      evidenceSha256: selection.qualificationSha256,
      approvalGeneration: selection.approvalGeneration,
      issuedAt: selection.issuedAt,
      expiresAt: selection.expiresAt,
      featureFlags: { ...off(), ...candidate },
      featureDomain: d,
      featureCompositionDigest: q.compositionDigest,
    };
    return {
      status: 'admitted',
      authority: Object.freeze({ ...identity, authorityKey: hash(identity) }),
    };
  } catch {
    return refuse('missing_evidence');
  }
}
export const liveHorseFeatureAuthority = new HorsePhase8AuthorityGate(
  () => admitHorseFeatureReleaseAuthority(),
  undefined,
  HORSE_FEATURE_AUTHORITY_VERSION
);
/** Reuse the maintained reference closure; worker and acceptance owners are
 * additionally mandatory because they derive and consume the selected flags. */
export function runningFeatureSourcePaths(): string[] {
  return [
    ...new Set([
      ...HORSE_REFERENCE_DECISION_SOURCE_FILES,
      'src/engine/HorseLogic.ts',
      'src/engine/HorseReferenceDecisionSources.ts',
      'src/engine/HorseFeatureAuthority.ts',
      'src/engine/HorseFeatureLiveDomain.ts',
      'src/config/leagueCashPricing.ts',
      'src/config/RakeConfig.ts',
      'src/config/rakeSpec.ts',
      'src/config/cashRakePolicy.ts',
      'src/engine/HorseQualifiedAuthority.ts',
      'src/engine/horseDecision/workerRuntime.ts',
      'src/engine/horseDecision/client.ts',
      'src/engine/horseDecision/protocol.ts',
      'src/engine/horseDecision/responseValidation.ts',
      'src/engine/HorsePlanEffectReceipt.ts',
      'src/engine/ServerTableEngineTurns.ts',
      'src/lightning/LightningHorse.ts',
      'src/lightning/LightningHandHost.ts',
      'src/engine/horseDecision/replay/qualifiedAuthority.ts',
      'src/types.ts',
    ]),
  ].sort();
}
function validFeatureEconomics(d: HorseFeatureDomain): boolean {
  return (
    Number.isFinite(d.smallBlind) &&
    d.smallBlind > 0 &&
    Number.isFinite(d.bigBlind) &&
    d.bigBlind >= d.smallBlind &&
    Number.isFinite(d.ante) &&
    d.ante >= 0 &&
    typeof d.bigBlindAnte === 'boolean' &&
    ['no_limit', 'pot_limit'].includes(d.bettingStructure) &&
    [0.01, 1].includes(d.chipUnit) &&
    d.sidePots === false &&
    Array.isArray(d.remainingPlayers) &&
    d.remainingPlayers.length > 0 &&
    d.remainingPlayers.every((n) => Number.isInteger(n) && n >= 2 && n <= 9) &&
    !!d.rakeConfig &&
    Number.isFinite(d.rakeConfig.percent) &&
    Number.isFinite(d.rakeConfig.cap) &&
    typeof d.rakeConfig.noFlopNoDrop === 'boolean' &&
    (d.bbjConfig === null ||
      (!!d.bbjConfig &&
        typeof d.bbjConfig.enabled === 'boolean' &&
        [d.bbjConfig.feeBB, d.bbjConfig.minPotBB, d.bbjConfig.minPlayersDealt].every(
          Number.isFinite
        )))
  );
}
export function featureDomainMatches(d: HorseFeatureDomain, gs: HorseGameStateV2): boolean {
  const active = gs.players.filter((p) => !p.is_folded),
    bb = gs.bigBlind;
  const depth =
    bb > 0 && active.length ? Math.min(...active.map((p) => (p.stack + p.bet) / bb)) : NaN;
  return (
    validFeatureEconomics(d) &&
    gs.gameVariant === d.variant &&
    gs.gameMode === d.mode &&
    gs.asset === d.asset &&
    gs.boardCount === d.boardCount &&
    gs.bombPot === false &&
    gs.allInOrFold === false &&
    gs.straddleActive === false &&
    d.dealtSeats.includes(gs.dealtSeatIds?.length ?? 0) &&
    gs.players.filter((p) => gs.dealtSeatIds?.includes(p.seat)).length ===
      gs.dealtSeatIds?.length &&
    gs.players
      .filter((p) => gs.dealtSeatIds?.includes(p.seat))
      .every(
        (p) =>
          Number.isFinite(p.totalInvested) &&
          Math.abs((p.stack + p.totalInvested) / bb - d.startingStackBB) < 1e-9
      ) &&
    d.remainingPlayers.includes(active.length) &&
    Number.isFinite(depth) &&
    depth >= d.effectiveStackBB[0] &&
    depth <= d.effectiveStackBB[1] &&
    gs.smallBlind === d.smallBlind &&
    gs.bigBlind === d.bigBlind &&
    gs.ante === d.ante &&
    gs.bigBlindAnte === d.bigBlindAnte &&
    gs.bettingStructure === d.bettingStructure &&
    gs.chipUnit === d.chipUnit &&
    gs.rakeConfig !== undefined &&
    hash(gs.rakeConfig) === hash(d.rakeConfig) &&
    gs.bbjConfig !== undefined &&
    hash(gs.bbjConfig) === hash(d.bbjConfig) &&
    Array.isArray(gs.pots) &&
    gs.pots.length <= 1
  );
}
export function admittedHorseFeatureFlags(
  authority: HorseQualifiedAuthority | null,
  usable: boolean,
  gs: HorseGameStateV2,
  caller: Partial<HorseFeatureFlags> | undefined
): HorseFeatureFlags {
  if (
    !usable ||
    !authority?.featureFlags ||
    !authority.featureDomain ||
    !featureDomainMatches(authority.featureDomain, gs)
  )
    return off();
  // A package cannot silently become a partially disabled, unqualified mixture.
  if (HORSE_FEATURE_FLAGS.some((k) => authority.featureFlags?.[k] && caller?.[k] === false))
    return off();
  return { ...authority.featureFlags };
}
export function horseFeatureAcceptanceUsable(
  decision: HorseDecision,
  gate = liveHorseFeatureAuthority
): boolean {
  if (!decision.featureAuthority) return true;
  const r = decision.featureAuthority,
    a = gate.mainAuthority();
  return (
    !!a &&
    r.version === 'horse-feature-decision-v1' &&
    r.compositionDigest === a.featureCompositionDigest &&
    hash(r.flags) === hash(a.featureFlags) &&
    hash(r.domain) === hash(a.featureDomain) &&
    gate.check(r.authority) === 'usable'
  );
}
export function recheckHorseFeaturesBeforeAcceptance(
  decision: HorseDecision,
  toCall: number
): HorseDecision {
  if (horseFeatureAcceptanceUsable(decision)) return decision;
  // These features change the reference itself. No off-arm reference was
  // calculated. Use the existing explicit liveness action, never relabel it.
  return { ...decision, action: toCall > 0 ? 'fold' : 'check', amount: undefined };
}
