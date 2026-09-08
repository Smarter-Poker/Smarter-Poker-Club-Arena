/**
 * A SECOND SATELLITE WIN IS NEVER WORTH ZERO, AND A RE-DRIVE NEVER PAYS TWICE.
 *
 * Satellite delivery is now one database transaction. These source laws pin
 * the durable distinction that used to live in an application branch:
 *
 *  - a seat delivered by this satellite is an exact replay;
 *  - a seat held from somewhere else converts this ticket to cash;
 *  - an old qualifier with no recorded origin is refused, not guessed;
 *  - every cash fallback uses the same place-scoped obligation key; and
 *  - COMPLETED is written only after the complete frozen plan is certified.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const manager = readFileSync(join(here, 'TournamentManager.ts'), 'utf8');
const migration = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    'supabase',
    'migrations',
    '20260908042300_a_satellite_finish_pays_one_frozen_entitlement_plan.sql'
  ),
  'utf8'
);

function sqlFunction(name: string): string {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}`;
  const start = migration.indexOf(marker);
  expect(start, `${name} is defined by the atomic satellite migration`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('\n$function$;', start);
  expect(end, `${name} has a complete SQL body`).toBeGreaterThan(start);
  return migration.slice(start, end + '\n$function$;'.length);
}

describe('satellite finish ownership', () => {
  it('the manager delegates the whole finish to one atomic RPC', () => {
    const awards = sliceMethod(manager, 'protected async processSatelliteAwards(');
    expect(awards).toContain("supabase.rpc('fn_settle_satellite_finish_atomic'");
    expect(awards).not.toContain("supabase.rpc('fn_award_satellite_seat'");
    expect(awards).not.toContain('payCash(');
    expect(awards).toContain('result?.ok !== true || result?.settled !== true');
  });

  it('the atomic contract begins only from COMPLETING and owns COMPLETED', () => {
    const finish = sqlFunction('fn_settle_satellite_finish_atomic');
    expect(finish).toContain("IF v_t.status<>'COMPLETING'");
    expect(finish).toMatch(/UPDATE public\.tournaments[\s\S]*?SET status='COMPLETED'/);
    expect(finish).toContain("reason','atomic_satellite_settlement_failed'");
    expect(finish).toContain("'settled',false");
  });
});

describe('an already seated satellite winner', () => {
  const delivery = sqlFunction('fn_deliver_satellite_ticket_exact');

  it('recognises an exact replay only by this satellite id', () => {
    expect(delivery).toMatch(
      /COALESCE\(v_existing\.is_satellite_qualifier,false\)[\s\S]*?v_existing\.source_satellite_id=p_satellite_id/
    );
    expect(delivery).toContain("'delivery','seat','already',true");
  });

  it('proves the payout, pool-transfer ledger and rake before accepting the replay', () => {
    const replay = delivery.slice(
      delivery.indexOf('IF FOUND THEN'),
      delivery.indexOf('ELSIF COALESCE(v_existing.is_satellite_qualifier,false)')
    );
    expect(replay).toContain('FROM public.tournament_payouts');
    expect(replay).toContain('FROM public.chip_ledger');
    expect(replay).toContain('FROM public.rake_records');
    expect(replay.indexOf('IF v_count<>1')).toBeLessThan(
      replay.indexOf("RETURN jsonb_build_object('delivery','seat','already',true")
    );
  });

  it('refuses unknown origin and cashes a seat held from somewhere else', () => {
    expect(delivery).toMatch(
      /v_existing\.source_satellite_id IS NULL[\s\S]*?RAISE EXCEPTION 'existing target satellite seat has ambiguous origin'/
    );
    expect(delivery).toContain("'delivery','cash','reason','seat_already_held_elsewhere'");
  });
});

describe('cash fallback remains exactly-once', () => {
  it('uses one stable place obligation for a ticket that cannot become a seat', () => {
    const finish = sqlFunction('fn_settle_satellite_finish_atomic');
    expect(finish).toMatch(
      /v_delivery->>'delivery'='cash'[\s\S]*?fn_settle_satellite_cash_entitlement_exact\([\s\S]*?p_tournament_id,'place',e\.position,p\.user_id,e\.ticket_value/
    );
  });

  it('checks the entire plan before committing the terminal status', () => {
    const finish = sqlFunction('fn_settle_satellite_finish_atomic');
    const complete = finish.indexOf("SET status='COMPLETED'");
    const check = finish.lastIndexOf('v_check:=public.fn_check_atomic_satellite_finish', complete);
    expect(check).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(check);
  });
});
