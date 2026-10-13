import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const migration = read(
  'supabase/migrations/20261013034406_a_diamond_jackpot_carries_its_whole_unpaid_allocation.sql'
);
describe('a Diamond jackpot retains its unpaid whole share', () => {
  it('preserves fraction constraints and records the whole clamped entitlement separately', () => {
    expect(migration).toContain('v_pool.main_residue + v_pool.main_whole_carry');
    expect(migration).toContain('v_pool.backup_residue + v_pool.backup_whole_carry');
    expect(migration).toContain('main_whole_carry = v_main_whole - o_main');
    expect(migration).toContain('backup_whole_carry = v_backup_whole - o_backup');
    expect(migration).toContain('main_residue   = v_exact_main - v_main_whole');
    expect(migration).toContain('backup_residue = v_exact_backup - v_backup_whole');
    expect(migration).not.toMatch(
      /DROP\s+CONSTRAINT|UPDATE\s+public\.(?:poker_diamond_jackpot_ledger|profiles|ca_mint_ledger)/i
    );
  });
  it('preserves the original withdrawal money tail and refuses retirement before a whole claim is lost', () => {
    const prior = read(
      'supabase/migrations/20261005152000_the_diamond_jackpot_is_decided_and_its_pool_is_player_side.sql'
    );
    const tail = (s: string) => {
      const start = s.indexOf("v_ref := 'bbjwithdraw:'");
      const end = s.indexOf('END $fn$;', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const value = s.slice(start, end);
      expect(value.length).toBeGreaterThan(100);
      return value;
    };
    expect(tail(migration)).toBe(tail(prior));
    expect(migration.indexOf('diamond_jackpot_withdrawal_has_whole_owed_carry')).toBeLessThan(
      migration.indexOf("v_ref := 'bbjwithdraw:'")
    );
    expect(migration).toContain(
      "CHECK(status='active' OR(main_whole_carry=0 AND backup_whole_carry=0))"
    );
    expect(migration).toContain('diamond_whole_carry_predecessor_history_changed');
    expect(migration).toContain('diamond_whole_carry_table_authority_changed');
  });
  it('executes the actual accepted-hand regression and financial controls in existing native CI', () => {
    const runner = read('tests/sql/run-diamond-jackpot-integration.py');
    for (const file of [
      'diamond-whole-carry-before.sql',
      'diamond-whole-carry-after.sql',
      'diamond-whole-carry-kernel.sql',
    ]) {
      expect(runner).toContain(file);
    }
    expect(read('scripts/ci/run-diamond-sql-acceptance.py')).toContain(
      'run-diamond-jackpot-integration.py'
    );
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 scripts/ci/run-diamond-sql-acceptance.py'
    );
    expect(read('tests/sql/diamond-whole-carry-concurrency.py')).toContain(
      'concurrent exact original hand returns accepted receipt'
    );
    expect(read('tests/sql/diamond-whole-carry-concurrency.py')).toContain('pg_blocking_pids(pid)');
    expect(read('tests/sql/diamond-whole-carry-after.sql')).toContain('fixture_carry_snapshot()');
  });
});
