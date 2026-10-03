/**
 * LAW: THE MONEY ALERTS PHASE SIX PROVED ARE CLOSED (2026-10-03).
 *
 * Twenty-nine open financial_alerts rows were read one by one against
 * production and every one is settled, conserved or not owed by a standing
 * ruling. They close with their own evidence; a stale 'approved' adjustment
 * whose obligation was paid is marked settled; and a wrong decision note on a
 * rejected adjustment is restated. Records only: no chips move.
 *
 * What this pins: the migration closes exactly the alerts it lists, each with
 * its own note naming the migration, asserts every pre-image, moves no chips
 * and changes no function.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE = '20261003141247_the_money_alerts_phase_six_proved_are_closed';
const MIG = readFileSync(resolve(process.cwd(), 'supabase/migrations', FILE + '.sql'), 'utf8');
const ids = [...MIG.matchAll(/\('([0-9a-f-]{36})'::uuid, '/g)].map((m) => m[1]);

describe('the money alerts phase six proved are closed', () => {
  it('lists twenty-nine distinct alerts, each with its own note', () => {
    expect(ids).toHaveLength(29);
    expect(new Set(ids).size).toBe(29);
    // The two WASP satellite alerts close with their payment, not here.
    expect(ids).not.toContain('25399c02-7987-4840-a712-5c8b5ff624dd');
    expect(ids).not.toContain('71b057a7-b0ff-43e7-8f9c-85564b3f8dc6');
  });

  it('asserts its pre-image and closes exactly what it lists', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain("RAISE EXCEPTION 'closure pre-image: not all 29 alerts are still open';");
    expect(MIG).toContain('IF v_n <> 29 THEN');
    expect(MIG).toContain("resolution = c.note || ' Migration ' || c_mig || '.'");
    expect(MIG).toContain(`-- @live-proof: (SELECT count(*) FROM public.financial_alerts WHERE resolution LIKE '%${FILE}%') = 29`);
  });

  it('settles the paid adjustment and restates the wrong note, nothing more', () => {
    expect(MIG).toContain("WHERE id = '04069754-fba7-46e4-89d5-5f96fe4fd437' AND status = 'approved';");
    expect(MIG).toContain('through adjustment d8e908a3 (tournament f7412940, place 1 owed 13,441.68, paid 13,441.68)');
    expect(MIG).not.toContain('a449e853... no');
  });

  it('moves no chips and changes no function', () => {
    expect(MIG).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(MIG).not.toMatch(/\b(chip_ledger|club_members|wallet_transactions|chip_treasury)\b/);
    expect(MIG).not.toMatch(/fn_credit|fn_settle|fn_debit/);
    expect(MIG).not.toContain('—');
  });
});
