/** Offline custody preflight only. Reconstruct the existing unsigned accepted
 * source export from exact raw PostgreSQL text and retained journal records.
 * A digest commits to supplied bytes; it never authenticates their acquisition,
 * grants source population coverage, issues a signature or selects a policy. */
import type { HorseJournalRecord } from '../horseDecisionJournal/record.js';
import { createUnsignedAcceptedCommitmentExport } from '../horseAcceptedRoster/exporter.js';
import { evidenceDigest } from './authority.js';
import { CORRECTIVE_LIMITS } from './contract.js';

interface CorrectiveSourceCustodyFlags {
  readonly version: 1;
  readonly sourceReadVerified: false;
  readonly qualified: false;
  readonly completePopulation: false;
  readonly activationAllowed: false;
}
export type CorrectiveSourceCustodyPreflight = CorrectiveSourceCustodyFlags &
  (
    | { readonly status: 'reconstructed_unsigned'; readonly custodyDigest: string }
    | {
        readonly status: 'unavailable';
        readonly custodyDigest: null;
        readonly reason: 'source_custody_input_bounds' | 'accepted_source_reconstruction_refused';
      }
  );

/** Rebuild, do not accept an earlier export or a caller's qualified flag.
 * The shared exporter validates the requested accepted record pin, immutable
 * source/hand identities, exact text hashes, accepted actions, settlement and
 * first-acceptance roster. The result deliberately contains no raw source,
 * cards, actors, connection metadata or private exception text. */
export function rebuildCorrectiveSourceCustody(
  records: readonly HorseJournalRecord[],
  handKey: string,
  acceptedHandRecordDigest: string,
  rows: readonly unknown[]
): CorrectiveSourceCustodyPreflight {
  const flags = {
    version: 1 as const,
    sourceReadVerified: false as const,
    qualified: false as const,
    completePopulation: false as const,
    activationAllowed: false as const,
  };
  const unavailable = (
    reason: 'source_custody_input_bounds' | 'accepted_source_reconstruction_refused'
  ): CorrectiveSourceCustodyPreflight =>
    Object.freeze({ ...flags, status: 'unavailable', custodyDigest: null, reason });
  if (
    !Array.isArray(records) ||
    records.length < 1 ||
    records.length > CORRECTIVE_LIMITS.records ||
    !Array.isArray(rows) ||
    rows.length !== 1
  )
    return unavailable('source_custody_input_bounds');
  try {
    const rebuilt = createUnsignedAcceptedCommitmentExport({
      records,
      handKey,
      acceptedHandRecordDigest,
      rows,
    });
    if (rebuilt.sourceExport.status !== 'unsigned_export')
      return unavailable('accepted_source_reconstruction_refused');
    return Object.freeze({
      ...flags,
      status: 'reconstructed_unsigned',
      custodyDigest: evidenceDigest(rebuilt),
    });
  } catch {
    return unavailable('accepted_source_reconstruction_refused');
  }
}
