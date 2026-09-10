import { supabase } from '../services/supabase.js';
import {
  verifySatelliteSettlementReceipt,
  type VerifiedSatelliteSettlementReceipt,
  verifySatelliteQualificationReceipt,
  type VerifiedSatelliteQualificationReceipt,
} from './satelliteSettlementReceipt.js';

export class SatelliteSettlementRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatelliteSettlementRefusedError';
  }
}

export class SatelliteSettlementOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SatelliteSettlementOutcomeUnknownError';
  }
}

interface SatelliteSettlementRetryOptions {
  attempts?: number;
  wait?: (delayMs: number) => Promise<void>;
}

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message?: unknown }).message ?? value);
  }
  return String(value);
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Replay the same idempotent whole-satellite request after a transport error.
 * If every direct response is lost, the resolver waits behind the same global
 * database lock before it distinguishes a committed receipt from a proven
 * RUNNING or COMPLETING miss. No caller may infer rollback from HTTP failure.
 */
export async function requestSatelliteSettlementReceipt(
  tournamentId: string,
  observedWinnerId: string,
  options: SatelliteSettlementRetryOptions = {}
): Promise<VerifiedSatelliteSettlementReceipt> {
  const attempts = Math.max(1, Math.min(8, Math.trunc(options.attempts ?? 5)));
  const wait = options.wait ?? defaultWait;
  const request = {
    p_tournament_id: tournamentId,
    p_observed_winner_id: observedWinnerId,
  };
  let lastFailure = 'satellite settlement returned no receipt';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data, error } = await supabase.rpc('fn_settle_satellite_tournament', request);
      if (!error) {
        const receipt = verifySatelliteSettlementReceipt(data, tournamentId, observedWinnerId);
        if (receipt) return receipt;
        lastFailure = 'satellite settlement returned an invalid stored receipt';
      } else {
        lastFailure = errorMessage(error);
      }
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) await wait(200 * 2 ** (attempt - 1));
  }

  try {
    const { data, error } = await supabase.rpc('fn_resolve_satellite_settlement_outcome', request);
    if (error) {
      lastFailure = `${lastFailure}; serialized outcome check failed: ${errorMessage(error)}`;
    } else {
      const outcome = record(data);
      const identityIsExact =
        outcome.ok === true &&
        outcome.tournament_id === tournamentId &&
        outcome.winner_id === observedWinnerId;
      if (
        identityIsExact &&
        outcome.satellite_committed === true &&
        outcome.definitively_not_committed === false &&
        outcome.status === 'COMPLETED'
      ) {
        const receipt = verifySatelliteSettlementReceipt(
          outcome.receipt,
          tournamentId,
          observedWinnerId
        );
        if (receipt) return receipt;
        lastFailure = `${lastFailure}; serialized committed receipt was invalid`;
      } else if (
        identityIsExact &&
        outcome.satellite_committed === false &&
        outcome.definitively_not_committed === true &&
        (outcome.status === 'RUNNING' || outcome.status === 'COMPLETING') &&
        outcome.receipt === null
      ) {
        throw new SatelliteSettlementRefusedError(lastFailure);
      } else {
        lastFailure = `${lastFailure}; serialized outcome shape was invalid`;
      }
    }
  } catch (error) {
    if (error instanceof SatelliteSettlementRefusedError) throw error;
    lastFailure = `${lastFailure}; status check failed: ${errorMessage(error)}`;
  }

  throw new SatelliteSettlementOutcomeUnknownError(
    `Satellite settlement outcome is unknown after ${attempts} identical attempt(s): ${lastFailure}`
  );
}

/** Same atomic retry protocol, bound to the exact equal-value cohort. */
export async function requestSatelliteQualificationReceipt(
  tournamentId: string,
  qualifiedUserIds: readonly string[],
  options: SatelliteSettlementRetryOptions = {}
): Promise<VerifiedSatelliteQualificationReceipt> {
  const attempts = Math.max(1, Math.min(8, Math.trunc(options.attempts ?? 5)));
  const wait = options.wait ?? defaultWait;
  const request = {
    p_tournament_id: tournamentId,
    p_qualified_user_ids: [...qualifiedUserIds].sort(),
  };
  let lastFailure = 'satellite settlement returned no receipt';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data, error } = await supabase.rpc('fn_complete_satellite_qualification', request);
      if (!error) {
        const receipt = verifySatelliteQualificationReceipt(data, tournamentId, qualifiedUserIds);
        if (receipt) return receipt;
        lastFailure = 'satellite settlement returned an invalid stored receipt';
      } else {
        lastFailure = errorMessage(error);
      }
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) await wait(200 * 2 ** (attempt - 1));
  }

  try {
    const { data, error } = await supabase.rpc(
      'fn_resolve_satellite_qualification_outcome',
      request
    );
    if (error) {
      lastFailure = `${lastFailure}; serialized outcome check failed: ${errorMessage(error)}`;
    } else {
      const outcome = record(data);
      const identityIsExact =
        outcome.ok === true &&
        outcome.tournament_id === tournamentId &&
        outcome.completion_kind === 'equal_qualifiers' &&
        Array.isArray(outcome.qualified_user_ids) &&
        outcome.qualified_user_ids.length === request.p_qualified_user_ids.length &&
        [...outcome.qualified_user_ids]
          .sort()
          .every((id, index) => id === request.p_qualified_user_ids[index]);
      if (
        identityIsExact &&
        outcome.satellite_committed === true &&
        outcome.definitively_not_committed === false &&
        outcome.status === 'COMPLETED'
      ) {
        const receipt = verifySatelliteQualificationReceipt(
          outcome.receipt,
          tournamentId,
          qualifiedUserIds
        );
        if (receipt) return receipt;
        lastFailure = `${lastFailure}; serialized committed receipt was invalid`;
      } else if (
        identityIsExact &&
        outcome.satellite_committed === false &&
        outcome.definitively_not_committed === true &&
        (outcome.status === 'RUNNING' || outcome.status === 'COMPLETING') &&
        outcome.receipt === null
      ) {
        throw new SatelliteSettlementRefusedError(lastFailure);
      } else {
        lastFailure = `${lastFailure}; serialized outcome shape was invalid`;
      }
    }
  } catch (error) {
    if (error instanceof SatelliteSettlementRefusedError) throw error;
    lastFailure = `${lastFailure}; status check failed: ${errorMessage(error)}`;
  }

  throw new SatelliteSettlementOutcomeUnknownError(
    `Satellite settlement outcome is unknown after ${attempts} identical attempt(s): ${lastFailure}`
  );
}

/** Persist the no-more-hands cohort before entering the atomic money owner. */
export async function prepareSatelliteQualification(
  tournamentId: string,
  qualifiedUserIds: readonly string[],
  leaseGeneration: string
): Promise<void> {
  const expected = [...qualifiedUserIds].sort();
  const { data, error } = await supabase.rpc('fn_prepare_satellite_qualification', {
    p_tournament_id: tournamentId,
    p_qualified_user_ids: expected,
    p_lease_generation: leaseGeneration,
  });
  if (error) throw error;
  if (verifySatelliteQualificationReceipt(data, tournamentId, expected)) return;
  const receipt = record(data);
  if (
    receipt.ok !== true ||
    receipt.qualification_prepared !== true ||
    receipt.tournament_id !== tournamentId ||
    receipt.completion_kind !== 'equal_qualifiers' ||
    receipt.lease_generation !== leaseGeneration ||
    !Array.isArray(receipt.qualified_user_ids) ||
    receipt.qualified_user_ids.length !== expected.length ||
    ![...receipt.qualified_user_ids].sort().every((id, index) => id === expected[index])
  ) {
    throw new SatelliteSettlementOutcomeUnknownError(
      'Satellite qualification boundary returned no exact durable admission'
    );
  }
}
