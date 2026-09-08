/**
 * LAW: A CHIP IS TWO DECIMAL PLACES, AND THE POLICIES THAT SURROUND IT EXIST.
 *
 * Roadmap 9.1, 9.3, 9.4, 9.8 - phase 9 of 9.
 *
 * Measured on production 2026-09-08 across 236 money columns: 137 declared
 * `numeric(_,2)`, 11 declared `numeric(_,4)`, and 86 were unconstrained
 * `numeric`. A balance that can hold a third decimal place, against a journal
 * (`chip_ledger.amount`, numeric(15,2)) that cannot record one, is a fraction
 * that lives in the balance and can never appear in a leg - and no
 * conservation check on this platform can see it, because both sides round the
 * same way.
 *
 * IT OPENED TWICE AND CLOSED ITSELF:
 *   rakeback_period_payouts.payout_amount   933 / 2,704 rows, -0.2385 chips
 *   union_rake_paid_daily_user.rake_amount  6,881 / 8,244 rows, +0.2799 chips
 * Total residue on the whole platform: 0.5184 chips. Which is exactly why the
 * unit is declared NOW, before an epoch reset writes an opening balance to
 * every account.
 *
 * These pins are on the SOURCE, not the database - a law test cannot reach
 * production. They guard the migration that declares the unit and the three
 * policies phase 9 wrote, so neither can be quietly dropped from the repo.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const chipUnitMigration = (): string => {
  const f = readdirSync(MIGRATIONS).find((n) => n.includes('one_definition_of_a_chip'));
  if (!f) throw new Error('the migration that declares the chip unit is missing from the repo');
  return readFileSync(join(MIGRATIONS, f), 'utf8');
};

describe('the unit is declared, and declared once', () => {
  const sql = chipUnitMigration();

  it('constrains every column to two decimal places', () => {
    expect(sql).toMatch(/= round\(%I, 2\)/);
    expect(sql).toMatch(/is_two_decimal_places/);
  });

  it('covers the journal’s own balance columns', () => {
    // chip_ledger.amount is already numeric(15,2); its four running-balance
    // columns were unconstrained, which is where a fraction would hide.
    for (const col of [
      'pre_from_balance',
      'pre_to_balance',
      'post_from_balance',
      'post_to_balance',
    ]) {
      expect(sql).toContain(`'chip_ledger','${col}'`);
    }
  });

  it('covers the live balances a player or an operator can hold', () => {
    for (const pair of [
      "'unions','chip_balance'",
      "'unions','rake_wallet'",
      "'agents','player_wallet_balance'",
      "'club_members','held_chips'",
    ]) {
      expect(sql).toContain(pair);
    }
  });

  it('covers the other currencies phase 8 guarded', () => {
    for (const pair of [
      "'agent_commissions','amount'",
      "'agent_commission_settlements','amount'",
      "'rakeback_period_payouts','payout_amount'",
    ]) {
      expect(sql).toContain(pair);
    }
  });

  it('adds every constraint NOT VALID first, so it binds new writes instantly', () => {
    // ALTER COLUMN TYPE would rewrite 2.36M-row tables under ACCESS EXCLUSIVE.
    expect(sql).toContain('NOT VALID');
    expect(sql).not.toMatch(/ALTER COLUMN .* TYPE/i);
  });

  it('takes every lock up front, in one statement', () => {
    /* A rolled-back probe of this exact migration deadlocked (40P01) on
       club_members after eight constraints, taking locks one table at a time
       against live play - the same shape that killed the phase 8 migration at
       02:19 and the hand re-drive at 04:03. */
    expect(sql).toMatch(/LOCK TABLE[\s\S]*?IN ACCESS EXCLUSIVE MODE/);
    // Comments stripped: the header explains the deadlock and names
    // ADD CONSTRAINT while doing so, which would defeat a positional check.
    const code = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*--.*$/gm, '');
    const lockIdx = code.indexOf('LOCK TABLE');
    const firstAlter = code.indexOf('ADD CONSTRAINT');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(firstAlter).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(firstAlter);
  });

  it('states its scope instead of discovering it', () => {
    // A migration that picks its own targets from the catalogue is the
    // "scope nobody stated" shape (CLAUDE.md 10.86). The list is explicit and
    // the migration aborts if a named table or column is not there.
    expect(sql).toMatch(/must be re-read/);
  });

  it('leaves the two columns with measured residue unvalidated, and says why', () => {
    // Rounding 7,814 settled rows would rewrite settled records - 10.9
    // forbids it. The constraint still refuses every NEW sub-cent value.
    expect(sql).toContain("'rakeback_period_payouts','payout_amount','f'");
    expect(sql).toContain("'union_rake_paid_daily_user','rake_amount','f'");
    expect(sql).toMatch(/COMMENT ON CONSTRAINT chk_payout_amount_is_two_decimal_places/);
    expect(sql).toMatch(/COMMENT ON CONSTRAINT chk_rake_amount_is_two_decimal_places/);
  });

  it('is idempotent - a re-run adds nothing twice', () => {
    expect(sql).toMatch(/FROM pg_constraint[\s\S]{0,300}CONTINUE;/);
  });
});

describe('the three contracts the standard never wrote', () => {
  it('a restatement policy exists and names its three outcomes', () => {
    const p = read('docs/CHIP-RESTATEMENT-POLICY.md');
    expect(p).toMatch(/CLAWBACK/);
    expect(p).toMatch(/WRITE-OFF/);
    expect(p).toMatch(/RE-RUN/);
    // A clawback for our own defect is forbidden - 10.9 rule 3.
    expect(p).toMatch(/Forbidden when our defect caused it/);
    // And it says who decides, by size, rather than leaving it to judgement.
    expect(p).toMatch(/under 1,000 chips/);
    expect(p).toMatch(/over 25,000/);
  });

  it('a journal retention policy exists and refuses silent deletion', () => {
    const p = read('docs/CHIP-JOURNAL-RETENTION-POLICY.md');
    expect(p).toMatch(/seven years/i);
    expect(p).toMatch(/never by deleting/i);
    // Nothing may move without the attestation that makes it checkable.
    expect(p).toMatch(/ca_ledger_day_manifests/);
  });

  it('an epoch reset contract exists and puts the closing position first', () => {
    const p = read('docs/CHIP-EPOCH-RESET-CONTRACT.md');
    expect(p).toMatch(/BEFORE anything is zeroed/);
    expect(p).toMatch(/ca_mint_ledger/);
    // A reset whose only undo is a database restore is not undoable.
    expect(p).toMatch(/One migration can put every balance back/);
  });
});
