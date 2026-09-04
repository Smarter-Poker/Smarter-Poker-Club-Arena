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
  FREE_BUY_HOSTS,
  FREE_BUY_SLOTS,
  FREE_BUY_TIERS,
  chicagoParts,
  chicagoDayKey,
  slotForChicagoHour,
} from '../services/FreeBuy.js';

interface Problem {
  event: string;
  says: string;
}

function check(problems: Problem[], event: string, ok: boolean, says: string): void {
  if (!ok) problems.push({ event, says });
}

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

  const problems: Problem[] = [];
  const seen = new Map<string, number>();

  for (const e of events) {
    const label = `${e.name} @ ${e.start_time}`;
    const startMs = Date.parse(String(e.start_time));
    const parts = chicagoParts(startMs);
    const slot = slotForChicagoHour(parts.hour);

    check(
      problems,
      label,
      !!slot,
      `starts at ${parts.hour}:00 Chicago, which is not a Free Buy slot`
    );
    check(
      problems,
      label,
      parts.minute === 0,
      `starts at ${parts.hour}:${parts.minute}, not on the hour`
    );
    if (!slot) continue;
    const cfg = FREE_BUY_TIERS[slot.tier];

    // one per host per slot per Chicago day
    const key = `${e.club_id}|${slot.chicagoHour}|${chicagoDayKey(startMs)}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);

    check(
      problems,
      label,
      Number(e.buy_in_amount) === 0 && Number(e.buy_in_fee) === 0,
      'the first entry is not free'
    );
    check(
      problems,
      label,
      Number(e.guaranteed_prize) === cfg.guarantee,
      `guarantee is ${e.guaranteed_prize}, the ${slot.tier} tier is ${cfg.guarantee}`
    );
    check(
      problems,
      label,
      Number(e.starting_chips) === cfg.startingChips,
      `starting stack is ${e.starting_chips}, not ${cfg.startingChips}`
    );

    // THE LAW CONFLICT. zz_freerolls_are_free_buy forces every 0-buy-in MTT to
    // 1.00 unless free_buy is set AND the price is positive. This is the line
    // that proves the tier survived the trigger.
    check(
      problems,
      label,
      Number(e.rebuy_cost) === cfg.rebuyCost,
      `rebuy is ${e.rebuy_cost}, the ${slot.tier} tier is ${cfg.rebuyCost}`
    );
    check(
      problems,
      label,
      Number(e.addon_cost) === cfg.addOnCost,
      `add-on is ${e.addon_cost}, the ${slot.tier} tier is ${cfg.addOnCost}`
    );
    check(
      problems,
      label,
      Number(e.addon_chips) === cfg.addOnChips,
      `the add-on pays ${e.addon_chips} chips, not ${cfg.addOnChips}`
    );

    check(problems, label, e.addon_from_start === true, 'the add-on does not open at sit-down');
    check(problems, label, e.add_on_available === true, 'the add-on is switched off');
    check(problems, label, e.is_rebuy === true, 'rebuys are switched off');
    check(
      problems,
      label,
      e.max_rebuys === null,
      `max_rebuys is ${e.max_rebuys}, and a NOT NULL value denies every rebuy`
    );
    check(
      problems,
      label,
      Number(e.late_reg_mins) === cfg.lateRegMinutes,
      `late reg is ${e.late_reg_mins} minutes, not ${cfg.lateRegMinutes}`
    );
    check(
      problems,
      label,
      Number(e.rebuy_levels) === Number(e.late_reg_levels),
      'the rebuy period and late registration do not close together'
    );

    const host = FREE_BUY_HOSTS.find((h) => h.clubId === e.club_id);
    check(problems, label, !!host, `club ${e.club_id} is not a Free Buy host`);
    if (host) {
      // The overlay bank depends on this and on nothing else.
      check(
        problems,
        label,
        (e.union_id ?? null) === host.unionId,
        `union_id is ${e.union_id}, and the overlay bank is chosen by it`
      );
    }

    console.log(
      `  ${slot.tier.padEnd(8)} ${String(parts.hour).padStart(2, '0')}:00 ` +
        `${String(e.name).padEnd(28)} gtd ${e.guaranteed_prize} rebuy ${e.rebuy_cost} ` +
        `addon ${e.addon_cost}x${e.addon_chips} entrants ${e.current_players} pool ${e.prize_pool} [${e.status}]`
    );
  }

  for (const [key, n] of seen) {
    if (n > 1)
      problems.push({ event: key, says: `${n} events for one host, slot and Chicago day` });
  }

  const perDay = new Map<string, number>();
  for (const e of events) {
    if (String(e.status).toUpperCase() === 'CANCELLED') continue;
    perDay.set(
      `${e.club_id}|${chicagoDayKey(Date.parse(String(e.start_time)))}`,
      (perDay.get(`${e.club_id}|${chicagoDayKey(Date.parse(String(e.start_time)))}`) ?? 0) + 1
    );
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
  for (const p of problems) console.error(`   ${p.event}: ${p.says}`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[freebuy:verify] failed:', err);
  process.exit(1);
});
