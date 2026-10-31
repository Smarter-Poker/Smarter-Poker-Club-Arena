import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyChangedPaths } from '../../scripts/ci/classify-ci-changes.mjs';

const migration = '20261031040028_member_win_loss_includes_paid_jackpot_shares.sql';
const read = (path: string) => readFileSync(path, 'utf8');
describe('paid jackpot member reporting qualification', () => {
  it.each([
    'scripts/ci/test-member-jackpot-win-loss.sh',
    'tests/fixtures/member-jackpot-win-loss/assertions.sql',
  ])('qualifies changes to %s', (path) => {
    expect(classifyChangedPaths([path])).toMatchObject({ server: true, tests: true });
  });
  it('runs the native regression in the existing required Data Console verdict', () => {
    expect(read('scripts/ci/test-data-console-postgres-contracts.sh')).toContain(
      'bash "$repo/scripts/ci/test-member-jackpot-win-loss.sh"'
    );
    const runner = read('scripts/ci/test-member-jackpot-win-loss.sh');
    expect(runner).toContain(migration);
    expect(runner).toContain('"$fixture/regression.sql"');
    expect(runner).toContain('"$fixture/assertions.sql"');
    expect(runner).toContain('"$fixture/everyone-assertions.sql"');
    expect(runner).toContain(
      '20261031044413_preserve_every_paid_jackpot_reporting_owner_and_wallet_recei.sql'
    );
    expect(runner).toContain('Paid jackpot missing from Win/Loss');
    expect(runner).toContain('Asynchronous notification.*jackpot_fixture_committed');
  });
  it('changes reporting and a committed signal, never existing balances or hand facts', () => {
    const sql = read(`supabase/migrations/${migration}`);
    expect(sql).toContain('FROM public.bbj_payout_recipients r');
    expect(sql).toContain('fn_ca_launch_accounting_accepts');
    expect(sql).toContain('fn_member_record_fact_club');
    expect(sql).toContain('ownership_certified');
    expect(sql).toContain('PERFORM public.fn_publish_member_record_user(p_user_id);');
    expect(sql).not.toMatch(
      /(?:UPDATE|INSERT INTO|DELETE FROM)\s+public\.(?:club_members|table_seats|ca_hand_facts|chip_ledger)/i
    );
    for (const name of [
      'ca_club_member_win_loss',
      'ca_club_members_win_loss',
      'ca_club_member_detail',
      'ca_club_member_statistics',
    ]) {
      expect(sql).toContain(`Member jackpot preimage changed: ${name}`);
    }
  });
});
