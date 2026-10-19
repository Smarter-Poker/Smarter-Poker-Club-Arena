/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH LIGHTNING HAND BUSTED THIS ANCHOR (2026-10-19)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A horse's treasury rebuy is keyed by `autoRebuyHorse` on
 * (table, player, hand number): one bust is one funding operation, however
 * often it is asked. At an ordinary cash table the hand number is the table's
 * own `handCount`, which moves with every hand it deals. A Lightning anchor
 * table deals nothing - its Cluster's halt parks it for as long as the
 * Cluster is Lightning - so its `handCount` never moves, and a second bust of
 * the same horse on the same anchor would present the FIRST bust's key and be
 * answered from that bust's immutable receipt: no chips, and a stop-loss count
 * spent on nothing.
 *
 * The bust's real identity is the Lightning hand that took the anchor to zero.
 * A pool session is entered only with chips on the anchor
 * (`fn_table_seats_lightning_pool_follows_seat`), and while it is open the
 * anchor stack moves only through Lightning settlement and between-hands
 * top-ups. So an open session whose anchor reads zero busted in a settled
 * Lightning hand of THAT session, and the latest such hand names this bust.
 * Lightning hand numbers are unique (`lightning_hand_one_per_hand_number`).
 *
 * Three answers, never two (CLAUDE.md 10.86):
 *   - `lightning`: the hand that busted the anchor in its open session;
 *   - `none`: no open session, or no zero-stack Lightning hand in it - the
 *     bust (if any) is not a Lightning one, and the table's own identity holds;
 *   - `unknown`: a read failed. The caller funds nothing on an unknown key.
 *
 * READ-ONLY. It moves no chip and writes no row.
 */
import { supabase } from '../services/supabase/client.js';

export type LightningBustIdentity =
  | { status: 'lightning'; handNumber: number }
  | { status: 'none' }
  | { status: 'unknown' };

export async function lightningBustIdentity(
  clusterId: string,
  playerId: string
): Promise<LightningBustIdentity> {
  try {
    const session = await supabase
      .from('lightning_pool_session')
      .select('id')
      .eq('cluster_id', clusterId)
      .eq('player_id', playerId)
      .is('exited_at', null)
      .order('entered_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (session.error) return { status: 'unknown' };
    const sessionId = (session.data as { id?: unknown } | null)?.id;
    if (typeof sessionId !== 'string' || !sessionId) return { status: 'none' };

    const slots = await supabase
      .from('lightning_pool_slot')
      .select('id')
      .eq('pool_session_id', sessionId);
    if (slots.error || !Array.isArray(slots.data)) return { status: 'unknown' };
    const slotIds = (slots.data as Array<{ id?: unknown }>)
      .map((s) => s.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (slotIds.length === 0) return { status: 'none' };

    const busts = await supabase
      .from('lightning_hand_player')
      .select('hand_id')
      .eq('player_id', playerId)
      .eq('stack_after', 0)
      .in('pool_slot_id', slotIds);
    if (busts.error || !Array.isArray(busts.data)) return { status: 'unknown' };
    const handIds = (busts.data as Array<{ hand_id?: unknown }>)
      .map((b) => b.hand_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (handIds.length === 0) return { status: 'none' };

    const hand = await supabase
      .from('lightning_hand')
      .select('hand_number')
      .in('hand_id', handIds)
      .not('settled_at', 'is', null)
      .order('settled_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (hand.error) return { status: 'unknown' };
    if (!hand.data) return { status: 'none' };
    const handNumber = Number((hand.data as { hand_number?: unknown }).hand_number);
    if (!Number.isSafeInteger(handNumber) || handNumber < 0) return { status: 'unknown' };
    return { status: 'lightning', handNumber };
  } catch {
    return { status: 'unknown' };
  }
}
