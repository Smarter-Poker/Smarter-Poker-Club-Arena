import { admitMixedF06Transfer, type MixedF06Transfer } from './mixedF06Custody.js';
import { supabase, resumeRetainedHandSubmission } from '../services/supabase.js';
import {
  bindToProcessRoot,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';
import { reportError } from '../services/errorReporter.js';
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
      if (
        error ||
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
      )
        throw new Error('f06_drained_custody_unproven');
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
