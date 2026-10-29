import { createHash, randomUUID } from 'node:crypto';
import { UUID_SHAPE } from '../lib/uuidShape.js';
import type { DrainedF06Custody } from './drainedF06Custody.js';

export interface CompletedF06CustodySeal {
  schema: 'completed-f06-custody/v1';
  releaseProof: 'terminal-teardown-complete-and-manager-stop-fence/v1';
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

const issuedEntries = new WeakSet<object>();

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
        releaseProof: 'terminal-teardown-complete-and-manager-stop-fence/v1' as const,
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
    const entry = Object.freeze({
      status: 'sealed' as const,
      seal,
      sha256: createHash('sha256').update(JSON.stringify(seal)).digest('hex'),
    });
    issuedEntries.add(entry);
    return entry;
  } catch {
    const entry = Object.freeze({ status: 'unsealed' as const, original, terminalProof });
    issuedEntries.add(entry);
    return entry;
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

/** Existing archived diagnostic read ceiling, also bounding sealed history. */
export const COMPLETED_F06_DIAGNOSTIC_LIMIT = 32;
const processHistoryEpoch = randomUUID();
export interface CompletedF06OmittedHistory {
  schema: 'completed-f06-omitted-history/v1';
  processEpoch: string;
  tournamentId: string;
  /** Omitted distinct authentic entry objects, not unique generation IDs. */
  count: number;
  sha256: string;
}
export interface CompletedF06DiagnosticWindow {
  schema: 'completed-f06-diagnostic-window/v1';
  processEpoch: string;
  tournamentId: string;
  sealed: readonly CompletedF06Custody[];
  unsealed: readonly CompletedF06Custody[];
  omitted: Readonly<CompletedF06OmittedHistory> | null;
}
const issuedHistory = new WeakSet<object>();
const issuedWindows = new WeakSet<object>();
const appendableWindows = new WeakSet<object>();
// Identity membership mirrors the original Set, including omitted records.
// Weak entries retain neither payloads nor original manager/engine graphs.
const windowMembership = new WeakMap<object, WeakSet<object>>();
export function inspectCompletedF06OmittedHistory(value: unknown, tournamentId: string) {
  const history = value as CompletedF06OmittedHistory | null;
  return history &&
    issuedHistory.has(history) &&
    Object.isFrozen(history) &&
    history.schema === 'completed-f06-omitted-history/v1' &&
    history.processEpoch === processHistoryEpoch &&
    history.tournamentId === tournamentId &&
    Number.isSafeInteger(history.count) &&
    history.count > 0 &&
    /^[a-f0-9]{64}$/.test(history.sha256)
    ? history
    : null;
}
export function createCompletedF06DiagnosticWindow(
  tournamentId: string
): Readonly<CompletedF06DiagnosticWindow> {
  if (!UUID_SHAPE.test(tournamentId)) throw Error('completed custody tournament unavailable');
  const window = Object.freeze({
    schema: 'completed-f06-diagnostic-window/v1' as const,
    processEpoch: processHistoryEpoch,
    tournamentId,
    sealed: Object.freeze([]),
    unsealed: Object.freeze([]),
    omitted: null,
  });
  issuedWindows.add(window);
  appendableWindows.add(window);
  windowMembership.set(window, new WeakSet());
  return window;
}
/** Every omitted entry was issued after the
 * exact irreversible manager/engine stop predicates; unknown custody never
 * enters the aggregate. No live source object or table identity union is kept.
 */
export function appendCompletedF06DiagnosticWindow(
  prior: Readonly<CompletedF06DiagnosticWindow>,
  entry: CompletedF06Custody
): Readonly<CompletedF06DiagnosticWindow> {
  if (
    !issuedWindows.has(prior) ||
    !appendableWindows.has(prior) ||
    prior.processEpoch !== processHistoryEpoch ||
    !Object.isFrozen(prior) ||
    (prior.omitted && !inspectCompletedF06OmittedHistory(prior.omitted, prior.tournamentId))
  )
    throw Error('completed custody history unavailable');
  const membership = windowMembership.get(prior);
  if (!entry || !issuedEntries.has(entry)) throw Error('completed custody seal unavailable');
  if (!membership) throw Error('completed custody history unavailable');
  if (entry && typeof entry === 'object' && membership.has(entry)) return prior;
  const seal = inspectCompletedF06Custody(entry);
  if (entry.status === 'sealed' && (!seal || seal.tournamentId !== prior.tournamentId))
    throw Error('completed custody seal unavailable');
  const sealed = [...prior.sealed];
  const unsealed = [...prior.unsealed];
  let omitted = prior.omitted;
  if (!seal) {
    // Refuse association rather than move unknown/foreign original custody
    // into this tournament's aggregate. Caller retains its exact prior owner.
    try {
      if (!('original' in entry) || entry.original.tournamentId !== prior.tournamentId)
        throw Error('foreign original');
    } catch {
      throw Error('completed custody original identity unavailable');
    }
    unsealed.push(entry);
  } else {
    if (seal.releaseProof !== 'terminal-teardown-complete-and-manager-stop-fence/v1')
      throw Error('completed custody release unavailable');
    sealed.push(entry);
    if (sealed.length > COMPLETED_F06_DIAGNOSTIC_LIMIT) {
      const oldest = sealed.shift()!;
      const original = inspectCompletedF06Custody(oldest);
      if (
        !original ||
        original.tournamentId !== prior.tournamentId ||
        original.releaseProof !== 'terminal-teardown-complete-and-manager-stop-fence/v1'
      )
        throw Error('completed custody omission unavailable');
      const count = (omitted?.count ?? 0) + 1;
      if (!Number.isSafeInteger(count)) throw Error('completed custody history exhausted');
      const sha256 = createHash('sha256')
        .update(
          JSON.stringify([
            'completed-f06-omitted-history/v1',
            processHistoryEpoch,
            prior.tournamentId,
            count,
            omitted?.sha256 ?? null,
            (oldest as Extract<CompletedF06Custody, { status: 'sealed' }>).sha256,
          ])
        )
        .digest('hex');
      omitted = Object.freeze({
        schema: 'completed-f06-omitted-history/v1' as const,
        processEpoch: processHistoryEpoch,
        tournamentId: prior.tournamentId,
        count,
        sha256,
      });
      issuedHistory.add(omitted);
    }
  }
  const window = Object.freeze({
    schema: prior.schema,
    processEpoch: processHistoryEpoch,
    tournamentId: prior.tournamentId,
    sealed: Object.freeze(sealed),
    unsealed: Object.freeze(unsealed),
    omitted,
  });
  membership.add(entry);
  appendableWindows.delete(prior);
  appendableWindows.add(window);
  issuedWindows.add(window);
  windowMembership.set(window, membership);
  return window;
}

export function inspectCompletedF06DiagnosticWindow(value: unknown, tournamentId: string) {
  const window = value as CompletedF06DiagnosticWindow | null;
  if (
    !window ||
    !issuedWindows.has(window) ||
    !appendableWindows.has(window) ||
    !Object.isFrozen(window) ||
    window.schema !== 'completed-f06-diagnostic-window/v1' ||
    window.processEpoch !== processHistoryEpoch ||
    window.tournamentId !== tournamentId ||
    window.sealed.length > COMPLETED_F06_DIAGNOSTIC_LIMIT ||
    window.sealed.some(
      (entry) => inspectCompletedF06Custody(entry)?.tournamentId !== tournamentId
    ) ||
    (window.omitted && !inspectCompletedF06OmittedHistory(window.omitted, tournamentId))
  )
    return null;
  return window;
}
