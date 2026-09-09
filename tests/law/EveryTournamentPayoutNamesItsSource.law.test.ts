import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const sourceMigration = readdirSync(MIGRATIONS).find((name) =>
  name.endsWith('_every_tournament_payout_names_its_source.sql')
);
if (!sourceMigration) {
  throw new Error('missing every_tournament_payout_names_its_source migration');
}
const HARDENING = readFileSync(join(MIGRATIONS, sourceMigration), 'utf8');
const lastCreditMigration = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }))
  .filter(({ sql }) => sql.includes('CREATE OR REPLACE FUNCTION public.fn_credit_and_log('))
  .at(-1);
if (!lastCreditMigration) {
  throw new Error('missing fn_credit_and_log migration');
}
const CASH_CORE = lastCreditMigration.sql;

const executable = (sql: string): string =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const SOURCES = [
  'structure',
  'reconcile',
  'hu_shortfall',
  'bounty',
  'bounty_residual',
  'own_bounty',
  'late_reg_adjustment',
  'clawback',
  'final_table_deal',
  'mystery_bounty',
  'mystery_bounty_residual',
  'spin_backpay',
  'overlay_backpay',
  'bubble_protection',
  'satellite_remainder',
  'satellite_seat',
  'satellite_ticket',
  'finish_position_correction',
] as const;

describe('every tournament payout names its source', () => {
  it('removes both silent fallbacks at the database boundary', () => {
    const sql = executable(HARDENING);
    expect(sql).toContain('ALTER COLUMN source DROP DEFAULT');
    expect(sql).toContain('ALTER COLUMN source SET NOT NULL');
    expect(CASH_CORE).not.toContain("v_shape_source, 'unclassified'");
  });

  it('rejects an unresolved or unknown class before the wallet move', () => {
    const start = CASH_CORE.indexOf('CREATE OR REPLACE FUNCTION public.fn_credit_and_log(');
    const end = CASH_CORE.indexOf('REVOKE ALL ON FUNCTION public.fn_credit_and_log(', start);
    const credit = CASH_CORE.slice(start, end);
    const missingGuard = credit.indexOf('has no recognized payout source');
    const unknownGuard = credit.indexOf('supplied unknown payout source');
    const walletMove = credit.indexOf('v_credited := public.fn_credit_player_wallet_once(');

    expect(missingGuard).toBeGreaterThan(-1);
    expect(unknownGuard).toBeGreaterThan(missingGuard);
    expect(walletMove).toBeGreaterThan(unknownGuard);
  });

  it('installs one explicit closed vocabulary in code and on the table', () => {
    const checkStart = HARDENING.indexOf('ADD CONSTRAINT tournament_payouts_source_check');
    const checkEnd = HARDENING.indexOf(')) NOT VALID;', checkStart);
    const check = HARDENING.slice(checkStart, checkEnd);

    for (const source of SOURCES) {
      expect(check, `${source} is allowed by the table`).toContain(`'${source}'`);
      expect(CASH_CORE, `${source} is allowed by the pre-credit guard`).toContain(`'${source}'`);
    }

    expect(check).not.toContain("'unclassified'");
    expect(check).not.toContain("'payout'");
    expect(HARDENING).toContain('VALIDATE CONSTRAINT tournament_payouts_source_check');
  });

  it('classifies the exact vacant-place grammar and its corrected place', () => {
    expect(HARDENING).toContain("s.kind = 'vacantplace'");
    expect(HARDENING).toContain("THEN 'finish_position_correction'");
    expect(HARDENING).toContain('THEN s.seg5::integer');
    expect(HARDENING).toContain(
      'tourney:32ae0fc3-3728-49b5-ba78-0d0ed96920db:vacantplace:eae3996f-9f4d-4fad-ae65-7cbd976240c1:3'
    );
  });

  it('will correct only the exact 32-row, 161.30-chip proven cohort', () => {
    expect(HARDENING).toContain('c_expected_rows constant integer := 32');
    expect(HARDENING).toContain('c_expected_amount constant numeric(15,2) := 161.30');
    expect(HARDENING).toContain(
      "c_expected_digest constant text := '2fa8c21ea518a69b669528154e8a9792'"
    );
    expect(HARDENING).toContain('tournament_players_position_repair_20260901');
    expect(HARDENING).toContain('wallet_credit_idempotency');
    expect(HARDENING).toContain("p.source = 'finish_position_correction'");
  });

  it('uses the explicit payout correction door and keeps immutable receipts', () => {
    expect(HARDENING).toContain(
      "SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record'"
    );
    expect(HARDENING).toContain('CREATE TABLE public.tournament_payout_source_corrections');
    expect(HARDENING).toContain('trg_tournament_payout_source_corrections_append_only');
    expect(HARDENING).toContain(
      'BEFORE UPDATE OR DELETE ON public.tournament_payout_source_corrections'
    );
    expect(HARDENING).toContain('no money moved');
  });
});
