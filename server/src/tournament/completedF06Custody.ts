import { createHash } from 'node:crypto';
import type { DrainedF06Custody } from './drainedF06Custody.js';

export interface CompletedF06CustodySeal {
  schema: 'completed-f06-custody/v1';
  tournamentId: string;
  originGeneration: string;
  capturedAtMs: number;
  sourceTableIds: readonly string[];
  originals: readonly Readonly<{
    tableId: string;
    engineId: string;
    lifecycle: string;
    allocationEpoch: string | null;
    diagnostic: unknown;
  }>[];
  managerDiagnostic: unknown;
  terminalProof: unknown;
  sourceProofSha256: string;
}
export type CompletedF06Custody =
  | Readonly<{ status?: 'unsealed'; original: DrainedF06Custody; terminalProof: unknown }>
  | Readonly<{ status: 'sealed'; seal: Readonly<CompletedF06CustodySeal>; sha256: string }>;

function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Terminal SQL is necessary, but physical original ownership must also be
 * positively released. A refused seal retains the exact prior object custody.
 */
export function completeF06Custody(
  original: DrainedF06Custody,
  terminalProof: unknown
): CompletedF06Custody {
  try {
    if (!terminalProof || typeof terminalProof !== 'object') throw Error('terminal proof unknown');
    const physical = original.manager.captureCompletedF06CustodyIdentity(original.engines);
    if (!physical) throw Error('physical custody unproven');
    if (
      physical.managerDiagnostic.tournamentId !== original.tournamentId ||
      physical.managerDiagnostic.leaseGeneration !== original.originGeneration
    )
      throw Error('original identity changed');
    if (
      original.sources.some(
        (source) =>
          !physical.originals.some(
            (identity) =>
              identity.tableId === source.table_id && identity.lifecycle === source.lifecycle
          )
      )
    )
      throw Error('original source identity unknown');
    const seal = freezeData(
      structuredClone({
        schema: 'completed-f06-custody/v1' as const,
        tournamentId: original.tournamentId,
        originGeneration: original.originGeneration,
        capturedAtMs: Date.now(),
        ...physical,
        terminalProof,
        sourceProofSha256: createHash('sha256')
          .update(JSON.stringify(original.proof))
          .digest('hex'),
      })
    );
    issuedSeals.add(seal);
    return Object.freeze({
      status: 'sealed',
      seal,
      sha256: createHash('sha256').update(JSON.stringify(seal)).digest('hex'),
    });
  } catch {
    return Object.freeze({ status: 'unsealed', original, terminalProof });
  }
}

/** A sealed record is issued only by this module's physical capture. Native
 * absence readers must not accept a caller-created JSON lookalike. */
const issuedSeals = new WeakSet<object>();
export function inspectCompletedF06Custody(
  entry: unknown
): Readonly<CompletedF06CustodySeal> | null {
  const row = entry as Extract<CompletedF06Custody, { status: 'sealed' }> | null;
  if (
    !row ||
    row.status !== 'sealed' ||
    !row.seal ||
    !issuedSeals.has(row.seal) ||
    !Object.isFrozen(row) ||
    !Object.isFrozen(row.seal) ||
    row.sha256 !== createHash('sha256').update(JSON.stringify(row.seal)).digest('hex')
  )
    return null;
  return row.seal;
}
