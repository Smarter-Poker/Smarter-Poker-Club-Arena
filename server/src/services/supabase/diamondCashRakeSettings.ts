import { supabase } from './client.js';
import {
  DiamondCashRakeSettingRefusal,
  diamondCashRakeSettingNames,
  diamondCashRakeStakeScope,
  resolveDiamondCashRakeSchedule,
  type DiamondCashRakeSchedule,
  type EconomicsRow,
} from '../../domain/diamondCashRakeSchedule.js';

/**
 * ═══ THE OWNER'S DIAMOND CASH RAKE SCHEDULE, READ FROM THE ONE PLACE ═════
 *
 * `ca_diamond_economics` is the single source of every Diamond rake number.
 * This module reads it; nothing in the server holds a copy. Changing any
 * answer is one INSERT, with no rebuild, no migration and no code change -
 * which is the entire point of the settings table and is lost the moment
 * something downstream keeps its own number.
 *
 * ── WHEN IT IS READ, AND WHY THE SNAPSHOT CANNOT GO STALE ────────────────
 *
 * ONCE PER DIAMOND CASH HAND, AT THE DEAL, AND NEVER CACHED ACROSS HANDS.
 * `ServerTableEngineDealing.dealHand` reads this before it allocates a hand
 * number, freezes the result into that hand's `HandConfig`, and throws the
 * snapshot away with the hand. So:
 *
 *   - a hand is priced by the schedule in force at the moment it was DEALT,
 *     which is the correct semantics on its own: a row the owner inserts
 *     while a hand is in the air must not re-price money already wagered
 *     under the old answer;
 *   - the newest published answer reaches every Diamond table on its next
 *     deal, with no invalidation signal to miss, no refresh interval to tune
 *     and no listener to lose a notification;
 *   - there is NO window in which a hand can be priced on a superseded
 *     number, because no number outlives the hand that read it. A
 *     time-to-live cache cannot say that - its whole shape is a window in
 *     which the old answer is still served - and an answer this engine priced
 *     money with while the owner had already changed it is exactly what must
 *     not happen.
 *
 * The cost is one SELECT per hand, on Diamond cash tables only, and six
 * values in one round trip is why it reads the table rather than making six
 * calls to `fn_ca_diamond_economic`. Nothing on the chip path reads this
 * module at all.
 *
 * ── A READ THAT FAILS DEALS NOTHING ──────────────────────────────────────
 *
 * This function throws rather than returning a default. A hand the engine
 * cannot price is a hand the settler will refuse, and a dealt hand that
 * cannot settle is worse than a hand never dealt - it has already taken
 * players' Diamonds into a pot. `dealHand` therefore declines to deal.
 *
 * The RESOLUTION of those rows - which row wins, and what an unset answer
 * means - is `resolveDiamondCashRakeSchedule` in the domain module, where it
 * is pure and can be driven by rows alone.
 */
export async function readDiamondCashRakeSchedule(
  bigBlind: number
): Promise<DiamondCashRakeSchedule> {
  const { data, error } = await supabase
    .from('ca_diamond_economics')
    .select('name, scope, value, value_text, recorded_at, id')
    .in('name', diamondCashRakeSettingNames())
    .in('scope', ['all', diamondCashRakeStakeScope(bigBlind)]);
  if (error) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_economics_unreadable:ca_diamond_economics (${error.message})`
    );
  }
  return resolveDiamondCashRakeSchedule((data ?? []) as EconomicsRow[], bigBlind);
}
