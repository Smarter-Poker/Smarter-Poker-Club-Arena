import { supabase } from '../services/supabase.js';
import { UUID_SHAPE as UUID } from '../lib/uuidShape.js';
import { isDeterministicSettlementRefusal } from './settlementRefusal.js';
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

/** The parameters one terminal request carried, as the database compares them. */
export interface TerminalSettlementParameters {
  settlementMode: TournamentTerminalSettlementMode;
  winnerId: string | null;
}

/**
 * The database holds an immutable receipt for this tournament and the replay
 * parameters disagree with it, and the stored receipt could not be adopted.
 *
 * This is deterministic: replaying the same request can only produce the same
 * refusal, so the caller must stop, raise one alert naming the disagreement,
 * and stand down. It is never retried and never treated as an unknown outcome.
 */
export class TerminalSettlementDisagreementError extends Error {
  readonly tournamentId: string;
  readonly observed: TerminalSettlementParameters;
  readonly stored: TerminalSettlementParameters | null;

  constructor(
    message: string,
    tournamentId: string,
    observed: TerminalSettlementParameters,
    stored: TerminalSettlementParameters | null
  ) {
    super(message);
    this.name = 'TerminalSettlementDisagreementError';
    this.tournamentId = tournamentId;
    this.observed = observed;
    this.stored = stored;
  }
}

interface TerminalSettlementRetryOptions {
  attempts?: number;
  /** Bounded reads of the stored receipt after a proven disagreement. */
  receiptReadAttempts?: number;
  wait?: (delayMs: number) => Promise<void>;
  dealProposal?: { proposalId: string; revision: string };
  /** Enables a fresh authoritative inactivity check, never an unconditional downgrade. */
  legacyDealAuthority?: 'proposal_authority_not_active';
}

const defaultWait = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

/**
 * The exact texts fn_complete_tournament_terminal and
 * fn_resolve_tournament_terminal_outcome raise (ERRCODE 40001) when a stored
 * receipt exists and the request's settlement mode or observed winner differs
 * from it. Measured 2026-09-10 05:40-06:23 UTC: 5,575 identical replays of
 * this refusal across three finished events, at up to 100 a second, because
 * the engine treated it like a lost response.
 */
const TERMINAL_DISAGREEMENT_PATTERN =
  /terminal (?:replay|outcome) parameters disagree with stored receipt/i;

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object' && 'message' in value) {
    return String((value as { message?: unknown }).message ?? value);
  }
  return String(value);
}

/** True only for the database's own deterministic replay-disagreement refusal. */
export function isTerminalReplayDisagreement(error: unknown): boolean {
  return TERMINAL_DISAGREEMENT_PATTERN.test(errorMessage(error));
}

/**
 * The database itself answered this request with an error: a PostgreSQL
 * SQLSTATE, or a PostgREST code raised before the statement ran. PostgREST
 * commits a request's transaction only when the statement succeeds, so an
 * answer like this is the database stating that THIS attempt rolled back.
 *
 * A transport failure is not such an answer. The engine client's own deadline
 * ('supabase_timeout'), a reset socket or a gateway page carries no SQLSTATE,
 * and the statement may still be running and may still commit.
 *
 * Measured 2026-09-26 02:30 UTC: 85c5885a's five completion attempts and its
 * resolver were each refused with 55P03 (lock timeout, 8 s on authenticator)
 * while the platform finish lane was held. Not one of them could have
 * committed, yet the event was reported "outcome unknown" and its manager
 * fenced every table engine; it completed on its own an hour later.
 */
export function databaseStatedRollback(error: unknown): boolean {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^(?:[0-9A-Z]{5}|PGRST\d{3})$/.test(code);
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

function storedParameters(raw: unknown): TerminalSettlementParameters | null {
  const row = record(raw);
  const mode = String(row.settlement_mode ?? '')
    .trim()
    .toLowerCase();
  const winner = typeof row.winner_id === 'string' ? row.winner_id.toLowerCase() : '';
  if ((mode !== 'places' && mode !== 'final_table_deal') || !UUID.test(winner)) return null;
  return { settlementMode: mode, winnerId: winner };
}

/** Read an existing immutable result through its serialized verifier; never pay. */
export async function readCommittedTournamentTerminalReceipt(
  tournamentId: string
): Promise<VerifiedTournamentCompletionReceipt | null> {
  const { data, error } = await supabase
    .from('tournament_terminal_settlements')
    .select('settlement_mode, winner_id')
    .eq('tournament_id', tournamentId)
    .maybeSingle();
  if (error) throw new TerminalSettlementOutcomeUnknownError(errorMessage(error));
  if (!data) return null;
  const stored = storedParameters(data);
  if (!stored) throw new TerminalSettlementOutcomeUnknownError('Invalid stored terminal identity');
  const response = await supabase.rpc('fn_resolve_tournament_terminal_outcome', {
    p_tournament_id: tournamentId,
    p_observed_winner_id: stored.winnerId,
    p_settlement_mode: stored.settlementMode,
  });
  if (response.error) throw new TerminalSettlementOutcomeUnknownError(errorMessage(response.error));
  const outcome = record(response.data);
  const receipt = verifyTournamentCompletionReceipt(
    outcome.receipt,
    tournamentId,
    stored.settlementMode,
    stored.winnerId
  );
  if (
    outcome.ok !== true ||
    outcome.terminal_committed !== true ||
    outcome.definitively_not_committed !== false ||
    outcome.status !== 'COMPLETED' ||
    outcome.tournament_id !== tournamentId ||
    outcome.mode !== stored.settlementMode ||
    !receipt
  )
    throw new TerminalSettlementOutcomeUnknownError(
      'Stored terminal outcome could not be verified'
    );
  return receipt;
}

/**
 * The database refused a replay because its stored receipt disagrees with what
 * this process observed. The receipt is the witness that was there (CLAUDE.md
 * 10.9): read it, replay with ITS parameters so the same authority hands back
 * the same immutable receipt, and let the caller reconcile its own view.
 *
 * Bounded on purpose. A receipt row the database says exists but this process
 * cannot read, or a replay that still fails with the stored parameters, is a
 * contradiction that one alert has to name; it is never a reason to try again
 * later, because nothing about it is transient.
 */
async function adoptStoredTerminalReceipt(
  tournamentId: string,
  observed: TerminalSettlementParameters,
  attempts: number,
  wait: (delayMs: number) => Promise<void>,
  refusal: string
): Promise<VerifiedTournamentCompletionReceipt> {
  let stored: TerminalSettlementParameters | null = null;
  let lastFailure = refusal;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { data, error } = await supabase
        .from('tournament_terminal_settlements')
        .select('settlement_mode, winner_id')
        .eq('tournament_id', tournamentId)
        .maybeSingle();
      if (error) {
        lastFailure = `stored receipt unreadable: ${errorMessage(error)}`;
      } else if (!data) {
        lastFailure = 'the database refused the replay but no stored receipt row is visible';
      } else {
        stored = storedParameters(data);
        if (!stored) {
          lastFailure = 'stored receipt row has an invalid settlement mode or winner';
        } else if (
          stored.settlementMode === observed.settlementMode &&
          (observed.winnerId === null || stored.winnerId === observed.winnerId)
        ) {
          // The parameters agree after all: the refusal is not explained by
          // the receipt this process can read. Do not loop on it.
          lastFailure =
            'stored receipt agrees with the observed parameters yet the replay was refused';
        } else {
          const { data: replay, error: replayError } = await supabase.rpc(
            'fn_complete_tournament_terminal',
            {
              p_tournament_id: tournamentId,
              p_observed_winner_id: stored.winnerId,
              p_settlement_mode: stored.settlementMode,
            }
          );
          if (replayError) {
            lastFailure = `replay with stored parameters refused: ${errorMessage(replayError)}`;
          } else {
            const receipt = verifyTournamentCompletionReceipt(
              replay,
              tournamentId,
              stored.settlementMode,
              stored.winnerId
            );
            if (receipt) return receipt;
            lastFailure = 'replay with stored parameters returned an invalid receipt';
          }
        }
      }
    } catch (error) {
      lastFailure = errorMessage(error);
    }
    if (attempt < attempts) await wait(200 * 2 ** (attempt - 1));
  }

  throw new TerminalSettlementDisagreementError(
    `Terminal settlement parameters disagree with the stored receipt for ${tournamentId} ` +
      `(observed ${observed.settlementMode}/${observed.winnerId ?? 'no winner'}, stored ` +
      `${stored ? `${stored.settlementMode}/${stored.winnerId}` : 'unreadable'}) and the ` +
      `stored receipt could not be adopted after ${attempts} attempt(s): ${lastFailure}`,
    tournamentId,
    observed,
    stored
  );
}

/**
 * Invoke the idempotent terminal authority and resolve a lost-response race by
 * replaying the exact same request. A transport error is never proof of a
 * rollback: PostgreSQL may already have committed the immutable receipt.
 *
 * A replay-disagreement refusal is not replayed with the observed parameters: the
 * database has a receipt and this request contradicts it. The receipt is
 * adopted instead (see adoptStoredTerminalReceipt), so the returned receipt's
 * winnerId and settlementMode may differ from what the caller observed.
 * Known missing-evidence refusals go directly to the same serialized outcome
 * resolver; they never prove rollback or release the caller by themselves.
 */
export async function requestTournamentTerminalReceipt(
  tournamentId: string,
  settlementMode: TournamentTerminalSettlementMode,
  observedWinnerId: string | null,
  options: TerminalSettlementRetryOptions = {}
): Promise<VerifiedTournamentCompletionReceipt> {
  const dealProposal = options.dealProposal ? { ...options.dealProposal } : undefined;
  const legacyDeal = options.legacyDealAuthority === 'proposal_authority_not_active';
  if (legacyDeal && (settlementMode !== 'final_table_deal' || dealProposal))
    throw new TerminalSettlementRefusedError('Legacy authority cannot replace proposal consent');
  if (settlementMode === 'final_table_deal' && !legacyDeal) {
    if (
      !dealProposal ||
      typeof dealProposal.proposalId !== 'string' ||
      !UUID.test(dealProposal.proposalId) ||
      typeof dealProposal.revision !== 'string' ||
      !/^[0-9a-f]{64}$/.test(dealProposal.revision)
    ) {
      throw new TerminalSettlementRefusedError(
        'Final-table settlement requires exact proposal consent'
      );
    }
  } else if (dealProposal) {
    throw new TerminalSettlementRefusedError(
      'Proposal consent cannot change ordinary place settlement'
    );
  }
  const proposalIdentityIsExact = (raw: unknown): boolean => {
    if (!dealProposal) return true;
    const value = record(raw);
    return (
      value.proposal_id === dealProposal.proposalId && value.revision === dealProposal.revision
    );
  };
  const attempts = Math.max(1, Math.min(8, Math.trunc(options.attempts ?? 5)));
  const receiptReadAttempts = Math.max(
    1,
    Math.min(5, Math.trunc(options.receiptReadAttempts ?? 3))
  );
  const wait = options.wait ?? defaultWait;
  const observed: TerminalSettlementParameters = {
    settlementMode,
    winnerId: observedWinnerId ? observedWinnerId.toLowerCase() : null,
  };
  const request = {
    p_tournament_id: tournamentId,
    p_observed_winner_id: observedWinnerId,
    p_settlement_mode: settlementMode,
  };
  const proposalRequest = dealProposal
    ? {
        ...request,
        p_proposal_id: dealProposal.proposalId,
        p_revision: dealProposal.revision,
      }
    : null;
  let lastFailure = 'terminal settlement returned no receipt';
  let attemptedWrites = 0;
  // Attempts whose outcome the database did not state: a lost response, or a
  // success whose receipt could not be verified. Only these can have committed.
  let unprovenAttempts = 0;
  // The resolver's own failure, when the database stated it (a SQLSTATE).
  let resolverRolledBack = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (legacyDeal) {
      let inactive = false;
      try {
        const capability = await supabase.rpc('fn_get_tournament_deal_consensus', {
          p_tournament_id: tournamentId,
        });
        const data = capability?.data;
        inactive =
          !capability?.error &&
          data &&
          typeof data === 'object' &&
          !Array.isArray(data) &&
          data.ok === false &&
          data.reason === 'proposal_authority_not_active';
      } catch {
        /* No authoritative response means no legacy money call. */
      }
      if (!inactive) {
        if (attempt === 1)
          throw new TerminalSettlementRefusedError(
            'Legacy deal authority is not confirmed inactive'
          );
        // A prior attempt may already have committed. Resolve its immutable
        // outcome before releasing a dealer; activation is not a proven miss.
        lastFailure = 'Legacy deal authority changed after an attempted settlement';
        break;
      }
    }
    try {
      attemptedWrites++;
      const { data, error } = proposalRequest
        ? await supabase.rpc('fn_complete_tournament_terminal_proposal', proposalRequest)
        : await supabase.rpc('fn_complete_tournament_terminal', request);
      if (!error) {
        const receipt = verifyTournamentCompletionReceipt(
          data,
          tournamentId,
          settlementMode,
          observedWinnerId
        );
        if (receipt && proposalIdentityIsExact(data)) return receipt;
        unprovenAttempts++;
        lastFailure = 'terminal settlement returned an invalid stored receipt';
      } else {
        if (isTerminalReplayDisagreement(error)) {
          return adoptStoredTerminalReceipt(
            tournamentId,
            observed,
            receiptReadAttempts,
            wait,
            errorMessage(error)
          );
        }
        if (!databaseStatedRollback(error)) unprovenAttempts++;
        lastFailure = errorMessage(error);
        if (isDeterministicSettlementRefusal(error, tournamentId)) break;
      }
    } catch (error) {
      if (error instanceof TerminalSettlementDisagreementError) throw error;
      unprovenAttempts++;
      lastFailure = errorMessage(error);
    }

    if (attempt < attempts) await wait(200 * 2 ** (attempt - 1));
  }

  // A plain MVCC status read cannot distinguish a rollback from a terminal
  // transaction that is still running after its HTTP response was lost. The
  // resolver acquires the exact global terminal lock first, so it waits for
  // that transaction and only then reports committed receipt or proven miss.
  try {
    const { data, error } = proposalRequest
      ? await supabase.rpc('fn_resolve_tournament_terminal_proposal_outcome', proposalRequest)
      : await supabase.rpc('fn_resolve_tournament_terminal_outcome', request);
    if (error) {
      if (isTerminalReplayDisagreement(error)) {
        // The receipt committed under different parameters while this request
        // was losing its responses. Adopt it rather than reporting an unknown
        // outcome that a successor would only re-ask with the same parameters.
        return adoptStoredTerminalReceipt(
          tournamentId,
          observed,
          receiptReadAttempts,
          wait,
          errorMessage(error)
        );
      }
      resolverRolledBack = databaseStatedRollback(error);
      lastFailure = `${lastFailure}; serialized outcome check failed: ${errorMessage(error)}`;
    } else {
      const outcome = record(data);
      const identityIsExact =
        outcome.ok === true &&
        outcome.tournament_id === tournamentId &&
        outcome.mode === settlementMode &&
        proposalIdentityIsExact(outcome);
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
        if (receipt && proposalIdentityIsExact(outcome.receipt)) return receipt;
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
    if (
      error instanceof TerminalSettlementRefusedError ||
      error instanceof TerminalSettlementDisagreementError
    ) {
      throw error;
    }
    lastFailure = `${lastFailure}; status check failed: ${errorMessage(error)}`;
  }

  // The resolver was itself refused by the database (the finish lane was held
  // past lock_timeout), and every write attempt before it was answered by the
  // database with a rollback. No attempt of this request is still running and
  // none committed, so this is a refusal the caller may retry: the terminal
  // authority is idempotent, and a retry that meets a receipt committed by
  // anyone else adopts it. A lost response anywhere, or a resolver that
  // answered with something this request cannot accept, stays unknown.
  if (attemptedWrites > 0 && unprovenAttempts === 0 && resolverRolledBack) {
    throw new TerminalSettlementRefusedError(
      `${lastFailure}; all ${attemptedWrites} attempt(s) were rolled back by the database, so none committed`
    );
  }

  throw new TerminalSettlementOutcomeUnknownError(
    `Terminal settlement outcome is unknown after ${attemptedWrites} identical attempt(s): ${lastFailure}`
  );
}
