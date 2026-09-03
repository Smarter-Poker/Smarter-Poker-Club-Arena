/**
 * THE PROMO WALLETS ARE ON THE CHIP METER, AND THE TRIAL BALANCE WATCHES ALL THREE.
 *
 * 2026-09-03, Dan (binding): "PROMO CHIPS ARE A PART OF THE BBJ RAKE, PART GOES
 * INTO THE MAIN BBJ, PART GOES INTO THE BACK UP BBJ WALLET AND PART GOES INTO
 * THE PROMO WALLET. WHAT LIABILITY OR ISSUES DO WE HAVE TO ADDRESS WITH IT?"
 *
 * The promo slice is real chips cut from the rake, and the meter could not see
 * a third of it. clubs.promo_balance was in no snapshot column, so every BBJ
 * promo sweep into a standalone club (5,010.18 over seven days) read as chips
 * leaving the world; and the trial balance measured the promo_wallet ledger
 * account against member promo alone, though the same account is written from
 * club promo and agent promo too.
 *
 * The rules this pins:
 *
 *   - the supply snapshot counts the club promo and club insurance floats;
 *   - it records them, and agent promo, in their own columns;
 *   - the trial balance measures promo_wallet against all three promo stores;
 *   - agent promo is not counted a second time inside agent_wallets;
 *   - insurance_bank is measured against the club float as well as the union's;
 *   - neither function is a browser door;
 *   - the migration proves itself with a rolled-back snapshot on the new basis.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('the_promo_wallets_are_on_the_chip_meter'))
  .sort()
  .pop();
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';

function body(name: string): string {
  const open = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(open, `${name} has moved or gone`).toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('the promo wallets are on the chip meter', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the promo meter migration is missing').toBeTruthy();
  });

  it('gives the club promo, club insurance and agent promo floats their own columns', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS club_promo\s+numeric/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS club_insurance\s+numeric/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS agent_promo\s+numeric/);
  });

  it('puts the two unmeasured club stores into the supply total', () => {
    const b = body('fn_ca_supply_snapshot');
    expect(b).toMatch(/\(SELECT COALESCE\(sum\(promo_balance\),0\) FROM clubs\)\s+AS club_promo/);
    expect(b).toMatch(
      /\(SELECT COALESCE\(sum\(insurance_balance\),0\) FROM clubs\)\s+AS club_insurance/
    );
    expect(b).toContain('+ s.club_promo + s.club_insurance');
    expect(b).toContain('club_promo, club_insurance, agent_promo, total');
  });

  it('measures the promo account against all three promo stores', () => {
    const b = body('fn_ca_trial_balance');
    expect(b).toMatch(
      /s1\.member_promo \+ COALESCE\(s1\.club_promo, 0\) \+ COALESCE\(s1\.agent_promo, 0\)/
    );
    expect(b).toMatch(
      /s0\.member_promo \+ COALESCE\(s0\.club_promo, 0\) \+ COALESCE\(s0\.agent_promo, 0\)/
    );
    // the old one-store basis is gone
    expect(b).not.toMatch(
      /'promo_wallets',\s*ARRAY\['promo_wallet'\],\s*s1\.member_promo\s*- s0\.member_promo/
    );
  });

  it('stops counting agent promo inside agent_wallets and adds the club insurance float to union_banks', () => {
    const b = body('fn_ca_trial_balance');
    expect(b).toMatch(/s1\.agent_wallets - COALESCE\(s1\.agent_promo, 0\)/);
    expect(b).toMatch(/s1\.union_wallets \+ COALESCE\(s1\.club_insurance, 0\)/);
  });

  it('rebaselines the latest snapshot so the change is not read as a one-time swing', () => {
    expect(SQL).toContain('UPDATE public.ca_supply_snapshots s');
    expect(SQL).toMatch(/total\s+= s\.total \+ round\(now_bal\.promo - since\.promo_in, 2\)/);
  });

  it('is not a browser door and proves itself with a rolled-back snapshot', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_supply_snapshot\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_trial_balance\(timestamp with time zone\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toContain('PROMO_METER_PROBE_ROLLBACK');
    expect(SQL).toContain('PROMO_METER_SELFCHECK_OK');
  });
});
