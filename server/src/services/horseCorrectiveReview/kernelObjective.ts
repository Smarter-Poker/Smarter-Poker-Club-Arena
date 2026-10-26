import { correctiveRiverSnapshotRefusal } from './kernelEligibility.js';
import { classifyTournamentRiverSnapshot } from './kernelTournamentEligibility.js';
import type { RiverDecisionInput } from './riverReference.js';
/** Strict version dispatch for the existing single Phase 14 attachment path.
 * Neither objective nor units are inferred from a mode, field name or caller flag.
 * Cash v1 signing and validation stay byte-for-byte owned by their original verifier. */
import {
  verifyCorrectiveKernelApproval,
  isVerifiedCorrectiveKernelApproval,
  type CorrectiveKernelApproval,
} from './kernelApproval.js';
import {
  verifyTournamentCorrectiveKernelApproval,
  isVerifiedTournamentCorrectiveKernelApproval,
  type TournamentCorrectiveKernelApproval,
} from './kernelTournamentApproval.js';
import {
  CORRECTIVE_KERNEL_CATALOG_VERSION,
  validateCorrectiveKernelCatalog,
  isValidatedCorrectiveKernelCatalog,
  type CorrectiveKernelCatalog,
} from './kernelCatalog.js';
import {
  TOURNAMENT_KERNEL_CATALOG_VERSION,
  validateTournamentCorrectiveKernelCatalog,
  isValidatedTournamentCorrectiveKernelCatalog,
  type TournamentCorrectiveKernelCatalog,
} from './kernelTournamentCatalog.js';
import { evidenceDigest } from './authority.js';
export type CorrectiveFunctionalKernelApproval =
  | CorrectiveKernelApproval
  | TournamentCorrectiveKernelApproval;
export type CorrectiveFunctionalKernelCatalog =
  | CorrectiveKernelCatalog
  | TournamentCorrectiveKernelCatalog;
export const functionalKernelCatalogVersionIsKnown = (
  value: unknown
): value is CorrectiveFunctionalKernelCatalog['version'] =>
  value === CORRECTIVE_KERNEL_CATALOG_VERSION || value === TOURNAMENT_KERNEL_CATALOG_VERSION;
export function verifyFunctionalKernelApproval(
  envelope: unknown,
  trustedDigest: string | undefined,
  nowMs: number
): CorrectiveFunctionalKernelApproval | null {
  try {
    const version = (envelope as { approval?: { version?: unknown } } | null)?.approval?.version;
    return version === 1
      ? verifyCorrectiveKernelApproval(envelope, trustedDigest, nowMs)
      : version === 2
        ? verifyTournamentCorrectiveKernelApproval(envelope, trustedDigest, nowMs)
        : null;
  } catch {
    return null;
  }
}
export function validateFunctionalKernelCatalog(
  raw: unknown,
  approval: CorrectiveFunctionalKernelApproval | null,
  running: { policyDigest: string; baselineSelectionsDigest: string; nowMs: number }
):
  | {
      status: 'validated';
      catalog: Readonly<CorrectiveFunctionalKernelCatalog>;
      activationAllowed: false;
    }
  | { status: 'refused'; reason: string } {
  if (isVerifiedCorrectiveKernelApproval(approval))
    return validateCorrectiveKernelCatalog(raw, approval, running);
  if (isVerifiedTournamentCorrectiveKernelApproval(approval))
    return validateTournamentCorrectiveKernelCatalog(raw, approval, running);
  return { status: 'refused', reason: 'kernel_approval_unverified' };
}
export function isValidatedFunctionalKernelCatalog(
  value: unknown
): value is Readonly<CorrectiveFunctionalKernelCatalog> {
  return (
    isValidatedCorrectiveKernelCatalog(value) || isValidatedTournamentCorrectiveKernelCatalog(value)
  );
}
export function functionalKernelCatalogDigest(value: CorrectiveFunctionalKernelCatalog): string {
  return evidenceDigest(value);
}

/** Cheap original-geometry admission before allocating the worker read frame.
 * Full model validation still runs after this necessary condition. */
export function functionalKernelSnapshotRefusal(
  snapshot: RiverDecisionInput['original']['snapshot'],
  catalog: Readonly<CorrectiveFunctionalKernelCatalog> | null
): string | null {
  if (!isValidatedFunctionalKernelCatalog(catalog)) return 'kernel_catalog_unverified';
  if (catalog.version === CORRECTIVE_KERNEL_CATALOG_VERSION)
    return correctiveRiverSnapshotRefusal(snapshot);
  const classified = classifyTournamentRiverSnapshot(snapshot);
  return classified.status === 'eligible' ? null : classified.reason;
}
