import { supabase } from '../services/supabase.js';
import { isDeterministicSettlementRefusal } from './settlementRefusal.js';
import {
  verifySatelliteSettlementReceipt,
  type VerifiedSatelliteSettlementReceipt,
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
 * Known missing-evidence refusals skip identical writes, but still require that
 * same serialized outcome check before the caller can release its finish guard.
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
  let attemptedWrites = 0;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      attemptedWrites++;
      const { data, error } = await supabase.rpc('fn_settle_satellite_tournament', request);
      if (!error) {
        const receipt = verifySatelliteSettlementReceipt(data, tournamentId, observedWinnerId);
        if (receipt) return receipt;
        lastFailure = 'satellite settlement returned an invalid stored receipt';
      } else {
        lastFailure = errorMessage(error);
        if (isDeterministicSettlementRefusal(error, tournamentId)) break;
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
    `Satellite settlement outcome is unknown after ${attemptedWrites} identical attempt(s): ${lastFailure}`
  );
}
