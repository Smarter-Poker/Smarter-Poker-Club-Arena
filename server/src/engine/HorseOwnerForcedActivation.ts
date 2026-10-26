/**
 * OWNER-FORCED ACTIVATION OF EVERY HORSE BRAIN PHASE (Dan 2026-10-26, BINDING).
 *
 * Dan, verbatim, on Phases 8, 10, 11, 12, 13 and 14 running in shadow because
 * every protected release selection was null after the brain's code digest
 * moved: "FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING".
 *
 * Until this order, a phase pack could only make live decisions after a locked
 * strength matrix had requalified the exact running source and its evidence
 * was committed as a protected release selection. Every brain change moved the
 * digest, so every pack fell back to shadow and stayed there (they had all
 * qualified before, at generation da94e437 and earlier).
 *
 * This module is the owner's authority, not a qualification. When a phase has
 * no admitted release selection, the live admission returns an authority
 * issued by this order for the RUNNING code (its own policy digest, pack
 * version and domain), so the worker and the main-thread gate admit the same
 * authority, every receipt is well formed, and the acceptance recheck passes
 * exactly as it would for a qualified pack. Nothing is skipped downstream:
 * withdrawals, safety sentinels, the domain rules each pack is built for and
 * every owner rule in `wager_rules` still apply.
 *
 * A committed release selection still wins: a qualified or withdrawn selection
 * is returned unchanged. A transient read failure is returned unchanged, so a
 * holder keeps its refresh semantics.
 */
import { createHash } from 'node:crypto';
import type {
  HorseAuthorityAdmission,
  HorseQualifiedAuthority,
} from './HorseQualifiedAuthority.js';

export const HORSE_OWNER_FORCED_ACTIVATION = Object.freeze({
  schema: 'horse-owner-forced-activation-v1' as const,
  orderedBy: 'Dan',
  orderedAt: '2026-10-26T04:10:00.000Z',
  order: 'FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING',
  phases: Object.freeze(['phase8', 'phase10', 'phase11', 'phase12', 'phase13', 'phase14']),
});

/** The switch. True: every phase without a release selection runs on the owner's order. */
export const HORSE_OWNER_FORCED_ACTIVATION_ENABLED = true;

function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort())
        out[key] = walk((v as Record<string, unknown>)[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(walk(value));
}
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Where the order is recorded, in place of a qualification file. */
export const HORSE_OWNER_FORCED_EVIDENCE_PATH = 'owner-order/2026-10-26-force-activate-every-phase';
/** The order's own digest: the evidence hash every forced authority carries. */
export const HORSE_OWNER_FORCED_EVIDENCE_SHA256 = sha256(
  canonicalJson(HORSE_OWNER_FORCED_ACTIVATION)
);
/** A 40-hex identity for fields that name a source commit. */
export const HORSE_OWNER_FORCED_SOURCE_SHA = HORSE_OWNER_FORCED_EVIDENCE_SHA256.slice(0, 40);
/** One approval generation for the order. */
export const HORSE_OWNER_FORCED_APPROVAL_GENERATION = 1;

const HEX64 = /^[0-9a-f]{64}$/;

export interface HorseOwnerForcedAuthorityFields {
  readonly phase: HorseQualifiedAuthority['phase'];
  readonly continuationVersion: string;
  /** The running code's own digest. Null or malformed: nothing is forced. */
  readonly policyDigest: string | null;
  readonly packId: string;
  readonly domain: string;
  readonly variant?: string;
  readonly contractDigest?: string | null;
  readonly admittedBoardCounts?: readonly number[];
  readonly catalogDigest?: string;
  readonly correctivePolicyDigest?: string;
  readonly baselineSelectionsDigest?: string;
  readonly holdoutDigest?: string;
  /** Extra values bound into the authority key only (completion definitions). */
  readonly keyExtras?: Readonly<Record<string, unknown>>;
}

/** The authority this order issues for the running code, or null when its digest is unknown. */
export function horseOwnerForcedAuthority(
  f: HorseOwnerForcedAuthorityFields
): HorseQualifiedAuthority | null {
  if (typeof f.policyDigest !== 'string' || !HEX64.test(f.policyDigest)) return null;
  const identity: Record<string, unknown> = {
    schema: 'horse-qualified-authority-v1',
    phase: f.phase,
    sourceSha: HORSE_OWNER_FORCED_SOURCE_SHA,
    continuationVersion: f.continuationVersion,
    policyDigest: f.policyDigest,
    packId: f.packId,
    domain: f.domain,
    evidencePath: HORSE_OWNER_FORCED_EVIDENCE_PATH,
    evidenceSha256: HORSE_OWNER_FORCED_EVIDENCE_SHA256,
    approvalGeneration: HORSE_OWNER_FORCED_APPROVAL_GENERATION,
    issuedAt: HORSE_OWNER_FORCED_ACTIVATION.orderedAt,
    expiresAt: null,
  };
  if (f.variant !== undefined) identity.variant = f.variant;
  if (typeof f.contractDigest === 'string') identity.contractDigest = f.contractDigest;
  if (f.admittedBoardCounts)
    identity.admittedBoardCounts = Object.freeze([...f.admittedBoardCounts]);
  for (const key of [
    'catalogDigest',
    'correctivePolicyDigest',
    'baselineSelectionsDigest',
    'holdoutDigest',
  ] as const)
    if (typeof f[key] === 'string') identity[key] = f[key];
  return Object.freeze({
    ...identity,
    authorityKey: sha256(
      canonicalJson({
        ...identity,
        ...(f.keyExtras ?? {}),
        ownerOrder: HORSE_OWNER_FORCED_EVIDENCE_SHA256,
      })
    ),
  }) as unknown as HorseQualifiedAuthority;
}

/** True when this authority was issued by the owner's order rather than a qualification. */
export function isHorseOwnerForcedAuthority(
  authority: Pick<HorseQualifiedAuthority, 'evidencePath' | 'evidenceSha256'> | null | undefined
): boolean {
  return (
    !!authority &&
    authority.evidencePath === HORSE_OWNER_FORCED_EVIDENCE_PATH &&
    authority.evidenceSha256 === HORSE_OWNER_FORCED_EVIDENCE_SHA256
  );
}

/**
 * The live admission: the release admission when it admitted or withdrew, or
 * a transient refusal unchanged; otherwise (no selection, or a selection whose
 * evidence no longer matches the running code) the owner-forced authority.
 */
export function withHorseOwnerForcedActivation(
  release: HorseAuthorityAdmission,
  forced: () => HorseQualifiedAuthority | null
): HorseAuthorityAdmission {
  if (!HORSE_OWNER_FORCED_ACTIVATION_ENABLED) return release;
  if (release.status !== 'refused' || release.transient) return release;
  let authority: HorseQualifiedAuthority | null = null;
  try {
    authority = forced();
  } catch {
    authority = null;
  }
  return authority ? { status: 'admitted', authority } : release;
}
