/**
 * A NEW CLUB'S FIRST 100,000 CHIPS COME FROM THE MINT, AND STAY IN THE CLUB.
 *
 * 2026-09-03, Dan (binding): "'THE MINT' WHERE ALL CHIPS AND DIAMONDS ARE
 * CREATED, AND MUST FLOW FROM. NEW CLUBS THAT ARE JUST CREATED START WITH
 * 100,000 CHIPS (FROM THE MINT TO THE CLUB UPON CREATION). THOSE CHIPS CAN
 * EVER ONLY BE USED INSIDE THAT CLUB."
 *
 * The opening grant was issued by two triggers that never touched the Mint
 * register: 13 clubs in 30 days, 1,300,000 chips, zero ca_mint_ledger rows
 * for chips. And the union clawback could pull a member club's treasury to
 * zero, opening grant included.
 *
 * The rules this pins:
 *
 *   - the opening grant journals from the Mint's account, issuance_reserve,
 *     never from the retired system_mint name;
 *   - the grant writes the Mint register (ca_mint_ledger, asset chips,
 *     holder club, op club-opening-grant:<club id>) linked to its journal row;
 *   - the club_opening_grant chip_transactions row stays (the integrity report
 *     and the quick reconcile read it);
 *   - the union clawback refuses to take a treasury below the opening grant;
 *   - the trigger functions are not browser doors;
 *   - the migration proves itself by creating a club inside a savepoint and
 *     rolling it back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const DIR = resolve(__dirname, '..', 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('a_new_clubs_first_100000_chips_come_from_the_mint'))
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

describe("a new club's first chips come from the Mint", () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the mint opening-grant migration is missing').toBeTruthy();
  });

  it('issues the opening grant from issuance_reserve, at 100,000, at INSERT', () => {
    const b = body('fn_seed_new_club_opening_bank');
    expect(b).toContain('NEW.chip_treasury := 100000');
    expect(b).toMatch(/fn_ca_declare_ledger\(\s*'mint',\s*'issuance_reserve'/);
    expect(b).not.toContain("'system_mint'");
  });

  it('writes the Mint register and links it to the journal row', () => {
    const b = body('fn_record_new_club_opening_bank');
    expect(b).toContain('INSERT INTO public.ca_mint_ledger');
    expect(b).toContain("'club-opening-grant:' || NEW.id::text");
    expect(b).toMatch(/\(v_op, 'mint', 'chips', 'club', NEW\.id, NEW\.name, 100000/);
    expect(b).toContain("WHERE asset = 'chips'");
    expect(b).toContain("'club_opening_grant'");
  });

  it('keeps the opening grant inside the club: the clawback floor', () => {
    const b = body('fn_union_clawback_from_club');
    expect(b).toContain("t.transaction_type = 'club_opening_grant'");
    expect(b).toContain('v_floor := 100000');
    expect(b).toContain('IF v_now - p_amount < v_floor THEN');
    expect(b).toContain('the opening grant stays in the club');
    // the 2.4 declaration survives
    expect(b).toMatch(/fn_ca_declare_ledger\('union_settlement',\s*'union_bank'/);
  });

  it('is not a browser door and proves itself by a rolled-back club', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_seed_new_club_opening_bank\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_record_new_club_opening_bank\(\) FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toContain('MINT_SELFCHECK_OK');
    expect(SQL).toContain('the probe club survived the rollback');
  });
});
