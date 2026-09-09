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
const stageB = migration('_tournament_manager_request_fencing_is_strict.sql');
const strict = migration('_hand_settlement_requires_exact_seat_generation.sql');

describe('the receipt-aware accepted-hand path retains exact seat generations', () => {
  it('models the real live chronology before contracting either legacy hand door', () => {
    expect(stageB.basename < strict.basename).toBe(true);
    expect(receipt.source).toContain('tournament_zero_stack_seat_generations');
    expect(receipt.source).toContain('post_commit_request_hash');
    expect(receipt.source).not.toContain('v_exact_seat_generation');

    expect(stageB.source).toContain("md5(v_settlement_core) <> '2e322bc7dfee3cf5cb6548ed3a587095'");
    expect(stageB.source).toContain("md5(v_settlement_door) <> '8ddb91f5f7bb5f27b609ec83cb69fa66'");
    expect(stageB.source).toContain(
      "'Stage-B manager fencing found an unknown hand-settlement source'"
    );
    expect(stageB.source.indexOf('2e322bc7dfee3cf5cb6548ed3a587095')).toBeLessThan(
      stageB.source.indexOf('DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(')
    );
  });

  it('pins the receipt preimages and their complete strict postimages', () => {
    for (const hash of [
      '2e322bc7dfee3cf5cb6548ed3a587095',
      '8ddb91f5f7bb5f27b609ec83cb69fa66',
      'ddb1762cff2ffe38369d542ff76f27b8',
      '022f0de6ed0fb51ff3fbe5f3ff36f6d0',
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
    expect(strict.source).not.toContain('OR (NOT v_exact_seat_generation');
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
