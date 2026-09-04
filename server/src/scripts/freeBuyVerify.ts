/**
 * FREE BUY, VERIFIED AGAINST THE LIVE BOARD.
 *
 *   npx tsx --env-file=server/.env src/scripts/freeBuyVerify.ts
 *
 * READ-ONLY. It creates nothing, registers nobody and moves no chips - it
 * reads the Free Buy events that exist and says, for each one, whether it
 * matches what Dan specified.
 *
 * WHY A SCRIPT AND NOT A TEST. Every rule below is already pinned by a unit
 * test against the row the code BUILDS. This checks the row the database
 * KEPT, which is a different question: five triggers rewrite a tournament row
 * on the way in, one of them exists specifically to force freeroll prices to
 * 1.00, and the whole point of the tier-aware migration is that it must not
 * touch a scheduled Free Buy. That can only be confirmed on a real row.
 *
 * Exit code 1 when anything disagrees, so it can be run from CI or by hand
 * after a deploy.
 */

import { supabase } from '../services/supabase.js';
import {
  FREE_BUY_SLOTS,
  auditFreeBuyBoard,
  chicagoParts,
  chicagoDayKey,
  slotForChicagoHour,
} from '../services/FreeBuy.js';

async function main(): Promise<void> {
  const { data, error } = await (supabase as any)
    .from('tournaments')
    .select(
      'id, name, club_id, union_id, status, start_time, guaranteed_prize, buy_in_amount, ' +
        'buy_in_fee, starting_chips, free_buy, addon_from_start, add_on_available, addon_cost, ' +
        'addon_chips, addon_levels, is_rebuy, is_reentry, rebuy_cost, rebuy_chips, rebuy_levels, ' +
        'max_rebuys, late_reg_mins, late_reg_levels, current_players, prize_pool'
    )
    .eq('free_buy', true)
    .gte('start_time', new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    .order('start_time', { ascending: true });

  if (error) {
    console.error('[freebuy:verify] could not read the board:', error.message);
    process.exit(1);
  }
  const events = (data ?? []) as any[];
  console.log(`[freebuy:verify] ${events.length} Free Buy event(s) in the last 24h and ahead`);
  if (events.length === 0) {
    console.log(
      '[freebuy:verify] NOTHING TO CHECK. The scheduler publishes three hours ahead, so an ' +
        'empty board means either the engine has not run a cycle yet or the board is off.'
    );
    process.exit(1);
  }

  /* THE RULES LIVE IN ONE PLACE. `auditFreeBuyBoard` is the same function the
     engine's hourly watch calls, so a one-shot check and the standing watch
     cannot drift into two opinions about what a correct Free Buy looks like. */
  const { problems } = auditFreeBuyBoard(events, Date.now());

  for (const e of events) {
    const startMs = Date.parse(String(e.start_time));
    const at = chicagoParts(startMs);
    const slot = slotForChicagoHour(at.hour);
    console.log(
      `  ${(slot?.tier ?? '?').padEnd(8)} ${String(at.hour).padStart(2, '0')}:00 ` +
        `${String(e.name).padEnd(28)} gtd ${e.guaranteed_prize} rebuy ${e.rebuy_cost} ` +
        `addon ${e.addon_cost}x${e.addon_chips} entrants ${e.current_players} pool ${e.prize_pool} [${e.status}]`
    );
  }

  const perDay = new Map<string, number>();
  for (const e of events) {
    if (String(e.status).toUpperCase() === 'CANCELLED') continue;
    const k = `${e.club_id}|${chicagoDayKey(Date.parse(String(e.start_time)))}`;
    perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  console.log('[freebuy:verify] per host per Chicago day:');
  for (const [k, n] of [...perDay].sort()) {
    console.log(`   ${k}  ${n} of ${FREE_BUY_SLOTS.length}`);
  }

  if (problems.length === 0) {
    console.log('[freebuy:verify] OK - every live Free Buy matches its tier.');
    process.exit(0);
  }
  console.error(`[freebuy:verify] ${problems.length} problem(s):`);
  for (const p of problems) console.error(`   ${p}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[freebuy:verify] failed:', err);
  process.exit(1);
});
