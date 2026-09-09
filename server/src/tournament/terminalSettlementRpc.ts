import { supabase } from '../services/supabase.js';
import {
  verifyTournamentCompletionReceipt,
  type TournamentTerminalSettlementMode,
  type VerifiedTournamentCompletionReceipt,
} from './completionSettlementReceipt.js';

export class TerminalSettlementRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalSettlementRefusedError';
  }
}

export class TerminalSettlementOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalSettlementOutcomeUnknownError';
  }
}

interface TerminalSettlementRetryOptions {
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
 * Invoke the idempotent terminal authority and resolve a lost-response race by
 * replaying the exact same request. A transport error is never proof of a
 * rollback: PostgreSQL may already have committed the immutable receipt.
 */
export async function requestTournamentTerminalReceipt(
  tournamentId: string,
  settlementMode: TournamentTerminalSettlementMode,
  observedWinnerId: string | null,
  options: TerminalSettlementRetryOptions = {}
): Promise<VerifiedTournamentCompletionReceipt> {
  const attempts = Math.max(1, Math.min(8, Math.trunc(options.attempts ?? 5)));
  const wait = options.wait ?? defaultWait;
  const request = {
    p_tournament_id: tournamentId,
    p_observed_winner_id: observedWinnerId,
    p_settlement_mode: settlementMode,
  };
  let lastFailure = 'terminal settlement returned no receipt';

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data, error } = await supabase.rpc('fn_complete_tournament_terminal', request);
      if (!error) {
        const receipt = verifyTournamentCompletionReceipt(
          data,
          tournamentId,
          settlementMode,
          observedWinnerId
        );
        if (receipt) return receipt;
        lastFailure = 'terminal settlement returned an invalid stored receipt';
      } else {
        lastFailure = errorMessage(error);
      }
    } catch (error) {
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) await wait(200 * 2 ** (attempt - 1));
  }

  // A plain MVCC status read cannot distinguish a rollback from a terminal
  // transaction that is still running after its HTTP response was lost. The
  // resolver acquires the exact global terminal lock first, so it waits for
  // that transaction and only then reports committed receipt or proven miss.
  try {
    const { data, error } = await supabase.rpc('fn_resolve_tournament_terminal_outcome', {
      p_tournament_id: tournamentId,
      p_observed_winner_id: observedWinnerId,
      p_settlement_mode: settlementMode,
    });
    if (error) {
      lastFailure = `${lastFailure}; serialized outcome check failed: ${errorMessage(error)}`;
    } else {
      const outcome = record(data);
      const identityIsExact =
        outcome.ok === true &&
        outcome.tournament_id === tournamentId &&
        outcome.mode === settlementMode;
      if (
        identityIsExact &&
        outcome.terminal_committed === true &&
        outcome.definitively_not_committed === false &&
        outcome.status === 'COMPLETED'
      ) {
        const receipt = verifyTournamentCompletionReceipt(
          outcome.receipt,
          tournamentId,
          settlementMode,
          observedWinnerId
        );
        if (receipt) return receipt;
        lastFailure = `${lastFailure}; serialized committed receipt was invalid`;
      } else if (
        identityIsExact &&
        outcome.terminal_committed === false &&
        outcome.definitively_not_committed === true &&
        (outcome.status === 'RUNNING' || outcome.status === 'COMPLETING') &&
        outcome.receipt === null
      ) {
        throw new TerminalSettlementRefusedError(lastFailure);
      } else {
        lastFailure = `${lastFailure}; serialized outcome shape was invalid`;
      }
    }
  } catch (error) {
    if (error instanceof TerminalSettlementRefusedError) throw error;
    lastFailure = `${lastFailure}; status check failed: ${errorMessage(error)}`;
  }

  throw new TerminalSettlementOutcomeUnknownError(
    `Terminal settlement outcome is unknown after ${attempts} identical attempt(s): ${lastFailure}`
  );
}
