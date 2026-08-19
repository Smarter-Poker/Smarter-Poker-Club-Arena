/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GAME ACCESS SERVICE — "may this user build a game for this club?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * One call to `fn_game_creation_access`, which answers with the SAME rule the
 * database enforces on the insert (`fn_can_create_games`, used by the `tables`
 * RLS policy and by `fn_create_tournament`). Asking here rather than
 * re-implementing the rule in TypeScript is the whole point — two copies of an
 * authorisation rule drift, and the copy the UI trusts is the one that is wrong.
 *
 * The RPC reads the caller from `auth.uid()`, so the answer cannot be spoofed by
 * passing someone else's id.
 *
 * Everything here fails CLOSED — see src/lib/gameCreationAccess.
 */
import { supabase } from '../lib/supabase';
import {
  parseGameCreationAccess,
  GAME_CREATION_DENIED,
  type GameCreationAccess,
} from '../lib/gameCreationAccess';

/** Ask the database whether the signed-in user may build games for this club. */
export async function fetchGameCreationAccess(
  clubUuid: string | null | undefined
): Promise<GameCreationAccess> {
  if (!clubUuid) return { allowed: false, unionId: null, reason: 'unknown_club' };
  try {
    const { data, error } = await supabase.rpc('fn_game_creation_access', {
      p_club_id: clubUuid,
    });
    if (error) return GAME_CREATION_DENIED;
    return parseGameCreationAccess(data);
  } catch {
    return GAME_CREATION_DENIED;
  }
}
