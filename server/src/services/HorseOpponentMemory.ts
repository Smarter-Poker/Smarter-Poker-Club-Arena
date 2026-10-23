import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';
import {
  memoryVariant,
  validOpponentProfile,
  type DurableOpponentProfile,
  type MemoryMode,
  type MemorySize,
} from '../engine/HorseOpponentMemory.js';

/** One bounded read in the original hand/decision path. The database owns
 * persistence and duplicate protection; there is no flush timer or repair job. */
export async function readHorseOpponentProfiles(
  userIds: string[],
  variant: string,
  mode: MemoryMode,
  size: MemorySize
): Promise<DurableOpponentProfile[]> {
  const v = memoryVariant(variant);
  if (!v) return [];
  const ids = [...new Set(userIds)].sort();
  if (ids.length < 1 || ids.length > 10) throw new Error('invalid opponent memory roster');
  const { data, error } = await supabase
    .rpc('fn_horse_exploit_profiles_read', {
      p_user_ids: ids,
      p_variant: v,
      p_mode: mode,
      p_size: size,
    })
    .abortSignal(AbortSignal.timeout(1500));
  if (error) throw new Error(`opponent memory unavailable: ${error.code ?? 'query'}`);
  if (
    !Array.isArray(data) ||
    data.length !== ids.length ||
    data.some(
      (p) =>
        !validOpponentProfile(p) ||
        !p.initialized ||
        p.variant !== v ||
        p.mode !== mode ||
        p.size !== size ||
        !ids.includes(p.user_id)
    ) ||
    new Set(data.map((p) => p.user_id)).size !== ids.length
  )
    throw new Error('opponent memory receipt incomplete');
  return data as DurableOpponentProfile[];
}

/** Fetch once per table hand, before enqueueing compute. Database latency on
 * one table must never block the process-wide decision FIFO. Each new client
 * (including a restarted worker) owns a fresh bounded cache. */
export function createDecisionOpponentProfileReader() {
  const pending = new Map<string, Promise<DurableOpponentProfile[]>>();
  return async (
    request: import('../engine/horseDecision/protocol.js').LiveHorseDecisionSnapshot
  ): Promise<DurableOpponentProfile[]> => {
    const gs = request.gameState,
      variant = memoryVariant(gs.gameVariant);
    if (!variant) return [];
    const count = gs.dealtSeatIds?.length ?? gs.players.length;
    const size: MemorySize = count <= 2 ? 'hu' : count <= 5 ? 'short' : 'full';
    const mode = gs.gameMode === 'tournament' || gs.tournament ? 'tournament' : 'cash';
    const ids = gs.players.map((p) => p.user_id).sort();
    // ServerTableEngineTurns constructs fence as table:hand:seat:lease:turn.
    const key = JSON.stringify([request.fence.split(':').slice(0, 2), variant, mode, size, ids]);
    const existing = pending.get(key);
    if (existing) return existing;
    const read = readHorseOpponentProfiles(ids, variant, mode, size).catch((error) => {
      pending.delete(key);
      reportError(error, 'HorseOpponentMemory.decisionRead');
      return [];
    });
    pending.set(key, read);
    while (pending.size > 2000) pending.delete(pending.keys().next().value!);
    return read;
  };
}
