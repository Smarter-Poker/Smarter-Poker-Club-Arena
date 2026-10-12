import { supabase } from '../lib/supabase';
import { parseArenaIdentity, type ArenaAccessContext } from '../../server/src/domain/ArenaContext';

// Match the existing ClubWorkspace authorization-read deadline. A timeout is
// unreadable access, never a membership refusal or an authorization grant.
const ARENA_ACCESS_READ_TIMEOUT_MS = 10_000;

/** Fresh server entitlement. No localStorage, synthetic membership or chip fallback. */
export async function getArenaContext(clubKey: string): Promise<ArenaAccessContext | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Arena Access Read Timed Out'));
    }, ARENA_ACCESS_READ_TIMEOUT_MS);
  });
  let response;
  try {
    response = await Promise.race([
      supabase
        .rpc('fn_poker_arena_context', { p_club_key: clubKey })
        .abortSignal(controller.signal),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const { data, error } = response;
  if (error) throw new Error(error.message || 'Could Not Verify Arena Access');
  if (data === null) return null;
  const arena = parseArenaIdentity(data.arena);
  if (typeof data.member !== 'boolean') throw new Error('Invalid Arena Access Response');
  const diamond = arena.kind === 'diamond_arena';
  if (diamond && (data.member !== true || data.role !== 'player'))
    throw new Error('Invalid Diamond Entitlement');
  return {
    arena,
    member: data.member,
    automaticMembership: diamond,
    cashGamesEnabled: diamond && data.cashGamesEnabled === true,
    tournamentsEnabled: diamond && data.tournamentsEnabled === true,
    role: typeof data.role === 'string' ? data.role : null,
    capabilities: {
      join: !diamond,
      hierarchy: !diamond,
      chipWallet: !diamond,
      diamondTransfers: diamond,
    },
  };
}
