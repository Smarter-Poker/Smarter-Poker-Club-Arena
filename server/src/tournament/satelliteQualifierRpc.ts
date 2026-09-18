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

/** Submit once, then resolve an uncertain response behind the same DB lane. */
export async function requestSatelliteQualifierReceipt(
  tournamentId: string,
  qualifierIds: readonly string[]
): Promise<VerifiedSatelliteQualifierReceipt> {
  if (!uuidShape(tournamentId) || !canonicalIds(qualifierIds) || qualifierIds.length === 0) {
    throw new SatelliteSettlementRefusedError('Satellite qualifier request identity is invalid');
  }
  const request = { p_tournament_id: tournamentId, p_observed_qualifier_ids: [...qualifierIds] };
  let failure = 'Satellite qualifier settlement did not return a valid receipt';
  try {
    const { data, error } = await supabase.rpc('fn_settle_satellite_qualifiers', request);
    if (!error) {
      const receipt = verifySatelliteQualifierReceipt(data, tournamentId, qualifierIds);
      if (receipt) return receipt;
    } else failure = String(error.message ?? error);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  try {
    const { data, error } = await supabase.rpc('fn_resolve_satellite_qualifier_outcome', request);
    if (error) throw error;
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
        if (receipt) return receipt;
      } else if (
        outcome.satellite_committed === false &&
        outcome.definitively_not_committed === true &&
        (outcome.status === 'RUNNING' || outcome.status === 'COMPLETING') &&
        outcome.receipt === null
      ) {
        throw new SatelliteSettlementRefusedError(failure);
      }
    }
  } catch (error) {
    if (error instanceof SatelliteSettlementRefusedError) throw error;
    failure += `; serialized outcome unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  throw new SatelliteSettlementOutcomeUnknownError(failure);
}
