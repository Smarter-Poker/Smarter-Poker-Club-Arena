import { supabase } from '../services/supabase.js';
import {
  readPersistedTournamentFormatContract,
  type TournamentFormatContract,
} from './tournamentEntryCapacity.js';

export type TournamentAdmissionAbi = 'legacy-capacity-v1' | 'unlimited-mtt-v2';
export interface TournamentAdmissionProjection {
  format_contract: TournamentFormatContract;
  admission_abi: TournamentAdmissionAbi;
  effective_max_players: number | null;
}

/** Strict readback only. This projection never authorizes a purchase or launch. */
export function readTournamentAdmissionSnapshot(
  data: unknown,
  parents: readonly { id: string; format_contract?: unknown }[]
): Map<string, TournamentAdmissionProjection> {
  const fail = (): never => {
    throw new Error('TOURNAMENT_ADMISSION_SNAPSHOT_INVALID');
  };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  const result = data as Record<string, unknown>;
  if (result.ok !== true || !Array.isArray(result.entries)) return fail();
  const abi = result.admission_abi;
  if (abi !== 'legacy-capacity-v1' && abi !== 'unlimited-mtt-v2') return fail();
  const expected = new Map(
    parents.map((row) => [row.id, readPersistedTournamentFormatContract(row)])
  );
  if (expected.size !== parents.length || result.entries.length !== parents.length) return fail();
  const projections = new Map<string, TournamentAdmissionProjection>();
  for (const value of result.entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const entry = value as Record<string, unknown>;
    const id = entry.tournament_id;
    if (typeof id !== 'string' || !expected.has(id) || projections.has(id)) return fail();
    const format = readPersistedTournamentFormatContract(entry);
    if (format !== expected.get(id)) return fail();
    const cap = entry.effective_max_players;
    const unlimited = abi === 'unlimited-mtt-v2' && (format === 'mtt-v1' || format === 'mtt-v2');
    if (
      unlimited ? cap !== null : typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap <= 0
    )
      return fail();
    projections.set(id, {
      format_contract: format,
      admission_abi: abi,
      effective_max_players: cap as number | null,
    });
  }
  return projections;
}

/** Bounded, pass-owned eligibility/funding read, never a boot-global mode cache. */
export async function projectTournamentAdmission<
  T extends { id: string; format_contract?: unknown },
>(rows: readonly T[]): Promise<Array<T & TournamentAdmissionProjection>> {
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new Error('TOURNAMENT_ADMISSION_DUPLICATE_PARENT');
  const out: Array<T & TournamentAdmissionProjection> = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    const chunk = rows.slice(offset, offset + 100);
    // Validate loaded parent format before issuing the corresponding read.
    chunk.forEach(readPersistedTournamentFormatContract);
    const { data, error } = await supabase.rpc('fn_ca_tournament_admission_snapshot', {
      p_tournament_ids: chunk.map((row) => row.id),
    });
    if (error) throw new Error(`Tournament admission snapshot unreadable: ${error.message}`);
    const projection = readTournamentAdmissionSnapshot(data, chunk);
    for (const row of chunk) out.push({ ...row, ...projection.get(row.id)! });
  }
  return out;
}
