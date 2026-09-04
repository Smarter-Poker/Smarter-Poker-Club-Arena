/**
 * ONLY THE REAL CLUBS EXIST, AND A CERTIFICATION FIXTURE RETIRES TO THE MINT.
 *
 * 2026-09-03, Dan (binding): "THE ONLY CLUB ARENA CLUBS ARE 'MIDWAY UNION'
 * WHICH IS A UNION, NOT A CLUB, CLUB JAQK, SHARK CLUB, AND DEEP STACK SOCIETY.
 * DELETE ANY OTHER CLUBS."
 *
 * Club Create Certification creates a throwaway club per run and deletes it in
 * a finally block. The delete failed every time - clubs -> chip_transactions is
 * ON DELETE SET NULL, which is an UPDATE on an append-only journal, and
 * chip_transactions.club_id is NOT NULL so it could never have worked - and the
 * script only warned. Fifteen fixtures accumulated holding 1,300,000 chips.
 *
 * The rules this pins:
 *
 *   - a fixture is retired by fn_ca_retire_certification_club, never by a bare
 *     DELETE;
 *   - its chips go to chip_retirement with a declared journal row, so the meter
 *     reads a burn and not a leak;
 *   - the four real estates are refused by id, so a rename cannot point this at
 *     Club JAQK;
 *   - anything that has played - a table, a tournament, an agent, a real member,
 *     a member holding chips - is refused;
 *   - the journals come out through the maintenance door that archives them;
 *   - the certification fails loudly if a fixture survives, instead of warning.
 *
 * Production after the sweep: exactly four clubs, 1,300,000 chips retired
 * across 13 declared burn rows, 13 journal rows archived in
 * ca_ledger_mutation_log.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const ROOT = resolve(__dirname, '..');
const DIR = resolve(ROOT, 'supabase/migrations');
const FILE = readdirSync(DIR)
  .filter((f) => f.includes('a_certification_club_is_retired_to_the_mint'))
  .sort()
  .pop();
const SQL = FILE ? readFileSync(resolve(DIR, FILE), 'utf8') : '';
const CERT = readFileSync(resolve(ROOT, 'scripts/ci/certify-club-create.mjs'), 'utf8');

function body(name: string): string {
  const open = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(open, `${name} has moved or gone`).toBeGreaterThan(-1);
  const start = SQL.indexOf('$function$', open);
  const end = SQL.indexOf('$function$', start + 10);
  expect(end).toBeGreaterThan(start);
  return SQL.slice(start, end);
}

describe('only the real clubs exist', () => {
  it('ships as a migration at all', () => {
    expect(FILE, 'the certification retirement migration is missing').toBeTruthy();
  });

  it('refuses the four real estates by id, whatever they are called', () => {
    const b = body('fn_ca_retire_certification_club');
    for (const id of [
      'a0000000-0000-0000-0000-000000000001',
      'a41434bb-8d0c-400a-8f0d-e8b3d65afed4',
      '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3',
      'fade0000-0000-0000-0000-000000000001',
    ]) {
      expect(b).toContain(id);
    }
    expect(b).toContain('that is a real Club Arena estate, not a fixture');
  });

  it('refuses anything that is not a fixture: named, unaffiliated, unplayed, cert-held', () => {
    const b = body('fn_ca_retire_certification_club');
    expect(b).toContain("v_club.name NOT LIKE 'Crest Cert %'");
    expect(b).toContain("v_club.name NOT LIKE 'Preset Crest Cert %'");
    expect(b).toContain('a fixture never belongs to a union');
    expect(b).toContain('this club has played: it is not a fixture');
    expect(b).toContain("NOT LIKE '%@smarter-poker.invalid'");
    expect(b).toContain('a fixture member still holds chips');
  });

  it('retires the chips to the Mint with a declared journal row', () => {
    const b = body('fn_ca_retire_certification_club');
    expect(b).toMatch(
      /fn_ca_declare_ledger\('burn', 'chip_retirement', NULL, NULL,\s*'cert-retire:'/
    );
    expect(b).toContain('SET chip_treasury     = 0');
    expect(b).toContain('promo_balance     = 0');
  });

  it('takes both append-only doors by name and closes them again', () => {
    const b = body('fn_ca_retire_certification_club');
    expect(b).toMatch(
      /set_config\('app\.ledger_maintenance', v_reason \|\| ':' \|\| p_club_id::text, true\)/
    );
    expect(b).toMatch(/set_config\('app\.game_management_retention', 'on', true\)/);
    expect(b).toMatch(/set_config\('app\.ledger_maintenance', '', true\)/);
    expect(b).toMatch(/set_config\('app\.game_management_retention', '', true\)/);
  });

  it('deletes in the order the foreign keys require', () => {
    const b = body('fn_ca_retire_certification_club');
    const tx = b.indexOf('DELETE FROM public.chip_transactions');
    const mem = b.indexOf('DELETE FROM public.club_members');
    const ev = b.indexOf('DELETE FROM public.game_management_events');
    const club = b.indexOf('DELETE FROM public.clubs WHERE id = p_club_id');
    expect(tx).toBeGreaterThan(-1);
    expect(mem).toBeGreaterThan(tx);
    expect(ev).toBeGreaterThan(mem);
    expect(club).toBeGreaterThan(ev);
  });

  it('sweeps the backlog and asserts only the four estates remain', () => {
    expect(SQL).toContain('cert-cleanup-backlog');
    expect(SQL).toContain('expected exactly the four real estates to remain');
    expect(SQL).toContain('fixture(s) still standing after the sweep');
  });

  it('is service_role only', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_ca_retire_certification_club\(uuid, text\)\s*FROM PUBLIC, anon, authenticated;/
    );
    expect(body('fn_ca_retire_certification_club')).toContain('service_role_only');
  });
});

describe('the certification cleans up after itself', () => {
  it('retires each fixture through the sanctioned door instead of a bare delete', () => {
    expect(CERT).toContain("admin.rpc('fn_ca_retire_certification_club'");
    expect(CERT).not.toMatch(/admin\.from\('clubs'\)\.delete\(\)/);
  });

  it('fails loudly when a fixture survives, instead of warning', () => {
    expect(CERT).toContain('Certification leaked');
    // the old warn-and-continue call is gone; the phrase survives only in the
    // comment that explains why it used to appear
    expect(CERT).not.toMatch(/console\.warn\(`Fixture Hard Delete Skipped/);
  });
});
