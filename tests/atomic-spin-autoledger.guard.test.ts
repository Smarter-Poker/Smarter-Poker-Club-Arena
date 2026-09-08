import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    __dirname,
    '..',
    'supabase/migrations/20260908153223_spin_reserve_settlement_commits_its_journal_or_nothing.sql'
  ),
  'utf8'
);

describe('Spin consumes the platform-wide strict auto-ledger', () => {
  it('pins the upstream authority before and after without replacing it', () => {
    expect(sql.match(/2ff8923b4c2d8fd3d343cf37acce0f2c/g)).toHaveLength(2);
    expect(sql).toContain(
      'Spin requires the audited platform-wide strict fn_ca_autoledger from 20260908024909'
    );
    expect(sql).toContain('Spin changed or lost the platform-wide strict auto-ledger authority');
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.fn_ca_autoledger\(\)/);
    expect(sql).not.toContain("v_strict := TG_TABLE_NAME = 'spin_bonus_pools'");
  });
});
