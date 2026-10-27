import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const sql = readFileSync(
  'supabase/migrations/20261027034254_existing_player_transfers_discharge_the_same_week_once.sql',
  'utf8'
);
const native = readFileSync('scripts/ci/test-existing-transfer-discharge-postgres.py', 'utf8');
const shard = readFileSync('scripts/dev/test-agent-accounting-statements.sh', 'utf8');
describe('existing owner-confirmed player transfers discharge the same week once', () => {
  it('installs one exact pinned transaction without hot public-table DDL', () => {
    expect(sql).toMatch(/^-- @live-proof:/);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql).toContain('existing_transfer_owner_preimage_changed');
    expect(sql).toContain('existing_transfer_postimage_changed');
    expect(sql).not.toMatch(
      /(?:ALTER TABLE|LOCK TABLE|ON public\.chip_ledger|REFERENCES public\.)/i
    );
    expect(sql).toContain("fn_ca_declare_guard_redefinition('fn_ca_settlement_correctness_check'");
  });
  it('requires original stage authority, real receipts and complete current certificates', () => {
    for (const token of [
      'existing_transfer_original_stage_context_required',
      'existing_transfer_credit_already_allocated',
      'existing_transfer_current_whole_club_calculation_required',
      'existing_transfer_commission_player_pass_through_requires_net_discharge',
      'owner_confirmed_existing_transfer',
      'DEFERRABLE INITIALLY DEFERRED',
      'UNIQUE(instruction_id,obligation_role)',
      'OFFSET 0',
    ])
      expect(sql).toContain(token);
    expect(sql).toContain("'treasury_transfer'");
    expect(sql).toContain('existing_transfer_economic_plan');
    expect(sql).toContain('existing_transfer_receipts');
  });
  it('runs the exact migration and actual original stages in the existing financial shard', () => {
    expect(shard).toContain('scripts/ci/test-existing-transfer-discharge-postgres.py');
    expect(native).toContain('exact-migration-rollback-install-postimages-acl-and-replay-refusal');
    expect(native).toContain('SET CONSTRAINTS ALL IMMEDIATE');
    expect(native).not.toContain("R/'work/discharge-support.sql'");
  });
});
