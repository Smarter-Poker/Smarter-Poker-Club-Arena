import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(process.cwd(), '..');

const migration = (suffix: string): { basename: string; source: string } => {
  const basenames = readdirSync(join(repoRoot, 'supabase', 'migrations')).filter((name) =>
    name.endsWith(suffix)
  );
  expect(basenames, suffix).toHaveLength(1);
  return {
    basename: basenames[0],
    source: readFileSync(join(repoRoot, 'supabase', 'migrations', basenames[0]), 'utf8'),
  };
};

const receipt = migration('_non_satellite_terminal_settlement_commits_one_stored_receipt.sql');
const restoredExact = migration('_restore_exact_hand_generation_after_terminal_writer.sql');
const stageB = migration('_tournament_manager_request_fencing_is_strict.sql');
const strict = migration('_hand_settlement_requires_exact_seat_generation.sql');

describe('the receipt-aware accepted-hand path retains exact seat generations', () => {
  it('models the real live chronology before contracting either legacy hand door', () => {
    expect(stageB.basename < strict.basename).toBe(true);
    expect(receipt.source).toContain('tournament_zero_stack_seat_generations');
    expect(receipt.source).toContain('post_commit_request_hash');
    expect(receipt.source).not.toContain('v_exact_seat_generation');
    expect(restoredExact.source).toContain('9be5d1da12d8f674a47a50ffb9a6df81');
    expect(restoredExact.source).toContain('f93a85ebe5a509ccb7dfedb9be1ed3fa');
    expect(restoredExact.source).toContain('v_exact_seat_generation');

    expect(stageB.source).toContain('fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority');
    expect(stageB.source).toContain("md5(v_settlement_core) <> 'ba1cdf1b56e5bb0c1c199b65390ee1f2'");
    expect(stageB.source).toContain("md5(v_settlement_door) <> 'f93a85ebe5a509ccb7dfedb9be1ed3fa'");
    expect(stageB.source).toContain(
      "md5(v_settlement_wrapper) <> '9d6a12c82aa260c22e1c013e95faca0e'"
    );
    expect(stageB.source).toContain(
      "'Stage-B manager fencing found an unknown composed hand-settlement source'"
    );
    expect(stageB.source.indexOf('ba1cdf1b56e5bb0c1c199b65390ee1f2')).toBeLessThan(
      stageB.source.indexOf('DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(')
    );
  });

  it('pins the receipt preimages and their complete strict postimages', () => {
    for (const hash of [
      '2e322bc7dfee3cf5cb6548ed3a587095',
      '8ddb91f5f7bb5f27b609ec83cb69fa66',
      'ba1cdf1b56e5bb0c1c199b65390ee1f2',
      'f93a85ebe5a509ccb7dfedb9be1ed3fa',
      'edfd095bae13ece6bedc989c3acd0467',
      '022f0de6ed0fb51ff3fbe5f3ff36f6d0',
      '9d6a12c82aa260c22e1c013e95faca0e',
    ]) {
      expect(strict.source).toContain(hash);
    }
    expect(strict.source).toContain('receipt-aware fn_ca_settle_hand_stacks_absolute changed');
    expect(strict.source).toContain('receipt-aware fn_ca_commit_hand_settlement changed');
    expect(strict.source).toContain('tournament_zero_stack_seat_generations');
    expect(strict.source).toContain('post_commit_request_hash');
    expect(strict.source).toContain('post_commit_payload_hash');
    expect(strict.source).toContain('ca:tournament-terminal-settlement:v1');
  });

  it('carries exact identity through canonicalization, locking, writes and time banks', () => {
    expect(strict.source).toContain("'seat_id', (x->>'seat_id')::uuid");
    expect(strict.source).toContain("'seat_joined_at', x->>'seat_joined_at'");
    expect(strict.source).toContain("ts.id = (target.value->>'seat_id')::uuid");
    expect(strict.source).toContain(
      "ts.joined_at = (target.value->>'seat_joined_at')::timestamptz"
    );
    expect(strict.source).toContain('WHERE ts.id = v_exact_seat_id');
    expect(strict.source).toContain('AND ts.joined_at = v_exact_seat_joined_at');
    expect(strict.source).toContain("WHERE ts.id = (e->>'seat_id')::uuid");
    expect(strict.source).toContain("AND ts.joined_at = (e->>'seat_joined_at')::timestamptz");
    expect(strict.source).toContain("AND s.id = (v_item->>'seat_id')::uuid");
    expect(strict.source).toContain("AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz");
    expect(strict.source).toContain('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK');
    expect(strict.source).toContain("OR position('v_exact_seat_generation' in v_outer) > 0");
    expect(strict.source).toContain('restored exact outer contraction produced an unknown source');
  });

  it('keeps the direct stack core owner-only and the receipt door service-only', () => {
    expect(strict.source).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(strict.source).toContain(
      "a.grantee NOT IN (\n         p.proowner,\n         (SELECT oid FROM pg_roles WHERE rolname = 'service_role')"
    );
    expect(strict.source).toContain('the direct stack implementation core is not owner-only');
    expect(strict.source).toContain('the exact hand RPC has an unexpected executor');
  });
});
