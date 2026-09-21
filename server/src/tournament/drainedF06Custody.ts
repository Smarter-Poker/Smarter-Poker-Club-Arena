import { admitMixedF06Transfer, type MixedF06Transfer } from './mixedF06Custody.js';
import { supabase, resumeRetainedHandSubmission } from '../services/supabase.js';
import {
  bindToProcessRoot,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';
import { reportError } from '../services/errorReporter.js';
import { f06DrainedCustodyOutcomesTotal } from '../observability/engineInstruments.js';
import type { ServerTableEngine } from '../engine/ServerTableEngine.js';
import type { TournamentManager } from './TournamentManager.js';

export interface DrainedF06Source {
  readonly break_id: string;
  readonly table_id: string;
  readonly lifecycle: string;
}
export interface DrainedF06Custody {
  readonly mixed?: MixedF06Transfer;
  readonly manager: TournamentManager;
  readonly tournamentId: string;
  readonly originGeneration: string;
  readonly engines: readonly (readonly [string, ServerTableEngine])[];
  readonly sources: readonly DrainedF06Source[];
  readonly current: () => boolean;
  readonly proof: unknown;
}

/**
 * WHY A DRAINED-CUSTODY READ WAS NOT PROVEN.
 *
 * `refused`   - the database answered, and its own refusal is named in `code`
 *               (F06_DRAINED_CUSTODY_NOT_PREMANIFEST, _LEASE_CHANGED,
 *               _SOURCE_CHANGED, _EVENT_CHANGED, _ORIGINAL_REQUIRED, ...).
 *               This is a DEFINITE answer about custody, not an outage.
 * `unreadable` - the call did not produce an answer (transport, timeout,
 *               permission, a 5xx). "I could not tell" - never silence.
 * `malformed` - a reply arrived that cannot be read as a verdict.
 */
export type F06DrainedCustodyOutcome = 'refused' | 'unreadable' | 'malformed';

export class F06DrainedCustodyUnprovenError extends Error {
  readonly outcome: F06DrainedCustodyOutcome;
  /** The database's own refusal token, or the transport's status. */
  readonly code: string;
  constructor(outcome: F06DrainedCustodyOutcome, code: string, detail: string) {
    // The legacy token stays at the head of the message: it is what existing
    // readers and guards match on, and only the missing half is added after it.
    super(`f06_drained_custody_unproven [${outcome}:${code}] ${detail}`.trimEnd());
    this.name = 'F06DrainedCustodyUnprovenError';
    this.outcome = outcome;
    this.code = code;
  }
}

/** Every refusal this function raises is spelled F06_..._... in its message. */
const F06_NAMED_REFUSAL = /F06_[A-Z0-9_]+/;

export function classifyF06CustodyError(error: unknown): {
  outcome: F06DrainedCustodyOutcome;
  code: string;
  detail: string;
} {
  const row = (error ?? {}) as { message?: unknown; code?: unknown; details?: unknown };
  const message = typeof row.message === 'string' ? row.message : '';
  const sqlstate = typeof row.code === 'string' && row.code ? row.code : 'no_sqlstate';
  const named = F06_NAMED_REFUSAL.exec(message);
  if (named) return { outcome: 'refused', code: named[0], detail: `sqlstate=${sqlstate}` };
  return {
    outcome: 'unreadable',
    code: sqlstate,
    detail: message.slice(0, 200) || 'the custody read produced no answer',
  };
}

function countF06CustodyOutcome(outcome: F06DrainedCustodyOutcome): void {
  try {
    f06DrainedCustodyOutcomesTotal.inc(1, { outcome });
  } catch {
    /* metrics must never affect a custody decision */
  }
}

/** An observation, never a lease, park mutation or financial disposition. */
export const readF06RecoveryAdmission = bindToProcessRoot(
  async (
    tournamentId: string,
    leaseGeneration: string | null,
    original: Pick<DrainedF06Custody, 'originGeneration' | 'sources' | 'proof'> | null = null
  ): Promise<{
    recoveryRequired: boolean;
    proof: unknown;
    terminalProof: unknown;
    pendingTables: readonly string[];
  }> => {
    const read = async () => {
      const { data, error } = await supabase.rpc('fn_f06_assert_drained_manager_custody', {
        p_tournament_id: tournamentId,
        p_lease_generation: leaseGeneration,
        p_origin_generation: original?.originGeneration ?? null,
        p_sources: original?.sources ?? [],
        p_expected: original?.proof ?? null,
      });
      /* THREE OUTCOMES, NOT ONE TOKEN (2026-09-21, CLAUDE.md 10.86 rules 1+2).
         This condition used to be one `if` ending in one bare
         `f06_drained_custody_unproven`, so a definite refusal from the
         database, a transport failure and a reply that could not be read all
         arrived as the same nine words with the database's own message thrown
         away. Production logged it 1,551 times in ninety minutes while six
         tournaments sat unadopted for days, and no reader could tell which of
         the six named SQL refusals was firing, or whether the database had
         even been reached. A refusal is an ANSWER and names itself; a
         transport failure is UNKNOWN; a malformed payload is neither. */
      if (error) {
        const classified = classifyF06CustodyError(error);
        countF06CustodyOutcome(classified.outcome);
        throw new F06DrainedCustodyUnprovenError(
          classified.outcome,
          classified.code,
          classified.detail
        );
      }
      if (
        !data ||
        data.ok !== true ||
        data.tournament_id !== tournamentId ||
        data.lease_generation !== leaseGeneration ||
        typeof data.recovery_required !== 'boolean' ||
        !data.proof ||
        typeof data.proof !== 'object' ||
        Array.isArray(data.proof) ||
        !Array.isArray(data.pending_tables) ||
        data.pending_tables.some(
          (id: unknown) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)
        ) ||
        new Set(data.pending_tables).size !== data.pending_tables.length ||
        !Array.isArray(data.terminal_proof) ||
        data.recovery_required !== data.pending_tables.length > 0
      ) {
        countF06CustodyOutcome('malformed');
        throw new F06DrainedCustodyUnprovenError(
          'malformed',
          'payload_is_not_an_answer',
          'the response did not carry one readable custody verdict'
        );
      }
      return {
        recoveryRequired: data.recovery_required,
        proof: data.proof,
        terminalProof: data.terminal_proof,
        pendingTables: data.pending_tables,
      };
    };
    return leaseGeneration
      ? runWithTournamentDataAuthority({ tournamentId, leaseGeneration }, read)
      : read();
  }
);

/** Preserve the original journal admission, once, before selecting custody-only ownership. */
export const prepareF06SuccessorAdmission = bindToProcessRoot(
  async (
    tournamentId: string,
    leaseGeneration: string,
    instanceId: string,
    original: DrainedF06Custody | null,
    current: () => boolean
  ) => {
    if (original?.mixed) {
      const state = await admitMixedF06Transfer(tournamentId, leaseGeneration, original.mixed);
      if (!current() || !original.current()) throw new Error('f06_successor_admission_changed');
      return state;
    }
    let state = await readF06RecoveryAdmission(tournamentId, leaseGeneration, original);
    if (!current()) throw new Error('f06_successor_admission_changed');
    for (const tableId of state.pendingTables) {
      try {
        await runWithTournamentDataAuthority({ tournamentId, leaseGeneration }, () =>
          resumeRetainedHandSubmission(tableId, instanceId, leaseGeneration)
        );
      } catch (error) {
        // Pending/unknown journal outcomes hold the real owner. They are not
        // absence, a no-start disposition, or permission to deal/abort the hand.
        reportError(error, 'Tournament.recovery_original_submission_pending', {
          tournamentId,
          tableId,
        });
        return { ...state, recoveryRequired: true };
      }
      if (!current()) throw new Error('f06_successor_admission_changed');
    }
    if (state.pendingTables.length)
      state = await readF06RecoveryAdmission(tournamentId, leaseGeneration, original);
    if (!current()) throw new Error('f06_successor_admission_changed');
    return state;
  }
);
