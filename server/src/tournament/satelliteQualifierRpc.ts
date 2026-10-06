import { supabase } from '../services/supabase.js';
import { uuidShape } from '../lib/uuidShape.js';
import {
  verifySatelliteQualifierReceipt,
  type VerifiedSatelliteQualifierReceipt,
} from './satelliteQualifierReceipt.js';
import {
  verifySatelliteSettlementReceipt,
  type VerifiedSatelliteSettlementReceipt,
} from './satelliteSettlementReceipt.js';
import {
  SatelliteSettlementOutcomeUnknownError,
  SatelliteSettlementRefusedError,
} from './satelliteSettlementRpc.js';
import { isLaneContention, isRolledBackStatementError } from './settlementRefusal.js';

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => !uuidShape(id))) return null;
  const ids = value as string[];
  return ids.every((id, index) => index === 0 || id > ids[index - 1]) ? ids : null;
}

function sameIds(value: unknown, expected: readonly string[]): boolean {
  const ids = canonicalIds(value);
  return (
    !!ids && ids.length === expected.length && ids.every((id, index) => id === expected[index])
  );
}

export type SatelliteQualifierState =
  | { state: 'entry_open' }
  | {
      state: 'unresolved' | 'continuing' | 'qualifying';
      fullTicketCount: number;
      qualifierIds: string[];
    }
  | { state: 'completed'; receipt: VerifiedSatelliteQualifierReceipt }
  | { state: 'completed_single_winner'; receipt: VerifiedSatelliteSettlementReceipt };

/** Eligibility is read by the same serialized financial owner as settlement. */
export async function readSatelliteQualifierState(
  tournamentId: string
): Promise<SatelliteQualifierState> {
  const { data, error } = await supabase.rpc('fn_get_satellite_qualifier_state', {
    p_tournament_id: tournamentId,
  });
  if (error) throw error;
  const value = record(data);
  if (value.ok !== true || value.tournament_id !== tournamentId)
    throw new Error('Satellite qualifier state identity is unproven');
  if (value.state === 'entry_open') return { state: 'entry_open' };
  if (value.state === 'completed') {
    const raw = record(value.receipt);
    const ids = canonicalIds(raw.qualifier_ids);
    const receipt = ids && verifySatelliteQualifierReceipt(raw, tournamentId, ids);
    if (receipt) return { state: 'completed', receipt };
  } else if (value.state === 'completed_single_winner') {
    const raw = record(value.receipt);
    const winner = uuidShape(raw.winner_id);
    const receipt = winner && verifySatelliteSettlementReceipt(raw, tournamentId, winner);
    if (receipt) return { state: 'completed_single_winner', receipt };
  } else if (
    value.state === 'unresolved' ||
    value.state === 'continuing' ||
    value.state === 'qualifying'
  ) {
    const ids = canonicalIds(value.qualifier_ids);
    const count = value.full_ticket_count;
    if (
      ids &&
      typeof count === 'number' &&
      Number.isSafeInteger(count) &&
      count >= 0 &&
      (value.state !== 'qualifying' || (count >= 2 && ids.length > 0 && ids.length <= count))
    ) {
      return { state: value.state, fullTicketCount: count, qualifierIds: ids };
    }
  }
  throw new Error('Satellite qualifier state is unreadable');
}

interface SatelliteQualifierRequestOptions {
  /** Serialized outcome reads, at most; the resolver writes nothing. */
  resolverAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error)
    return String((error as { message?: unknown }).message ?? error);
  return String(error);
}

/**
 * Submit once. A Postgres error is the database saying this call rolled back
 * (isRolledBackStatementError), so it is a refusal the next sweep retries,
 * never an unknown outcome. Only a lost response asks the resolver, and the
 * resolver's own lane contention is asked again rather than reported as
 * unknown: it is a read, and the read is what makes the outcome knowable.
 */
export async function requestSatelliteQualifierReceipt(
  tournamentId: string,
  qualifierIds: readonly string[],
  options: SatelliteQualifierRequestOptions = {}
): Promise<VerifiedSatelliteQualifierReceipt> {
  if (!uuidShape(tournamentId) || !canonicalIds(qualifierIds) || qualifierIds.length === 0) {
    throw new SatelliteSettlementRefusedError('Satellite qualifier request identity is invalid');
  }
  const resolverAttempts = Math.max(1, Math.min(5, Math.trunc(options.resolverAttempts ?? 3)));
  const wait = options.wait ?? defaultWait;
  const request = { p_tournament_id: tournamentId, p_observed_qualifier_ids: [...qualifierIds] };
  let failure = 'Satellite qualifier settlement did not return a valid receipt';
  try {
    const { data, error } = await supabase.rpc('fn_settle_satellite_qualifiers', request);
    if (!error) {
      const receipt = verifySatelliteQualifierReceipt(data, tournamentId, qualifierIds);
      if (receipt) return receipt;
    } else {
      failure = describe(error);
      if (isRolledBackStatementError(error)) {
        const code = (error as { code: string }).code;
        throw new SatelliteSettlementRefusedError(`${failure} (${code})`);
      }
    }
  } catch (error) {
    if (error instanceof SatelliteSettlementRefusedError) throw error;
    failure = describe(error);
  }
  const settleFailure = failure;
  for (let attempt = 1; attempt <= resolverAttempts; attempt++) {
    const outcome = await readSerializedOutcome(request, tournamentId, qualifierIds, settleFailure);
    if (outcome.kind === 'committed') return outcome.receipt;
    if (outcome.kind === 'not_committed') throw new SatelliteSettlementRefusedError(settleFailure);
    failure = `${outcome.failure} (resolver attempt ${attempt}/${resolverAttempts})`;
    if (!outcome.retry || attempt === resolverAttempts) break;
    await wait(500 * 2 ** (attempt - 1));
  }
  throw new SatelliteSettlementOutcomeUnknownError(failure);
}

type SerializedOutcome =
  | { kind: 'committed'; receipt: VerifiedSatelliteQualifierReceipt }
  | { kind: 'not_committed' }
  | { kind: 'unreadable'; failure: string; retry: boolean };

async function readSerializedOutcome(
  request: { p_tournament_id: string; p_observed_qualifier_ids: string[] },
  tournamentId: string,
  qualifierIds: readonly string[],
  failure: string
): Promise<SerializedOutcome> {
  try {
    const { data, error } = await supabase.rpc('fn_resolve_satellite_qualifier_outcome', request);
    if (error) {
      // Contention (55P03 lock_timeout behind the exclusive finish lane, a
      // serialization or deadlock victim, a statement timeout) read nothing;
      // a transport failure (code '') may simply be asked again.
      const code = (error as { code?: unknown }).code;
      return {
        kind: 'unreadable',
        failure: `${failure}; serialized outcome unavailable: ${describe(error)}`,
        retry: isLaneContention(error) || code === '' || code === undefined,
      };
    }
    const outcome = record(data);
    if (
      outcome.ok === true &&
      outcome.tournament_id === tournamentId &&
      sameIds(outcome.qualifier_ids, qualifierIds)
    ) {
      if (
        outcome.satellite_committed === true &&
        outcome.definitively_not_committed === false &&
        outcome.status === 'COMPLETED'
      ) {
        const receipt = verifySatelliteQualifierReceipt(
          outcome.receipt,
          tournamentId,
          qualifierIds
        );
        if (receipt) return { kind: 'committed', receipt };
      } else if (
        outcome.satellite_committed === false &&
        outcome.definitively_not_committed === true &&
        (outcome.status === 'RUNNING' || outcome.status === 'COMPLETING') &&
        outcome.receipt === null
      ) {
        return { kind: 'not_committed' };
      }
    }
    // A well-formed answer that proves neither outcome is not asked again.
    return {
      kind: 'unreadable',
      failure: `${failure}; serialized outcome shape was invalid`,
      retry: false,
    };
  } catch (error) {
    return {
      kind: 'unreadable',
      failure: `${failure}; serialized outcome unavailable: ${describe(error)}`,
      retry: true,
    };
  }
}
