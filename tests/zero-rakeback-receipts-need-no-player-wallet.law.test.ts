import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027171556_zero_rakeback_receipts_need_no_player_wallet.sql',
  'utf8'
);
describe('zero rakeback receipts need no player wallet', () => {
  it('changes only the exact original player wallet cohort, preserving metadata', () => {
    expect(sql).toContain('38e8a0bf0b309b973391107e3bd934d0');
    expect(sql).toContain('b07dc0dc2bdfa00973b4613e0cfb83d5');
    expect(sql).toContain('_routed_player_todo WHERE owed>0 GROUP BY club_id,user_id;');
    expect(sql).toContain('after_meta IS DISTINCT FROM before_meta');
    expect(sql).toContain('zero_rakeback_wallet_install_frozen');
    expect(sql).not.toMatch(
      /INSERT INTO public\.|UPDATE public\.|DELETE FROM public\.|CREATE TABLE|GRANT |cron\./
    );
  });
  it('keeps the actual whole financial family and proves the missing zero wallet regression', () => {
    const native = readFileSync('scripts/ci/test-zero-rakeback-wallet-postgres.py', 'utf8');
    for (const proof of [
      'test-existing-transfer-discharge-postgres.py',
      'old-zero-entitlement-missing-wallet-blocks-positive-players',
      'zero-entitlement-paid-receipt-without-wallet-or-credit',
      'positive-missing-wallet-still-requires-original-history',
      'positive-nan-wallet-remains-refused',
      'forced_wallet_rollback',
      'oldmeta',
    ])
      expect(native).toContain(proof);
    expect(
      readFileSync('.github/workflows/unpaid-lightning-funding-contracts.yml', 'utf8')
    ).toContain(
      'python3 -B scripts/ci/test-zero-rakeback-wallet-postgres.py --pg-bin "$PG_BIN" --scratch-root "${{ runner.temp }}"'
    );
  });
});
