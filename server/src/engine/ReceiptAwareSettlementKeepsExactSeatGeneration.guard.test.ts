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
const contraction = migration('_stage_b_current_postimage_contraction.sql');

describe('the receipt-aware accepted-hand path retains exact seat generations', () => {
  it('models the real live chronology before contracting either legacy hand door', () => {
    expect(receipt.source).toContain('tournament_zero_stack_seat_generations');
    expect(receipt.source).toContain('post_commit_request_hash');
    expect(receipt.source).not.toContain('v_exact_seat_generation');
    expect(restoredExact.source).toContain('9be5d1da12d8f674a47a50ffb9a6df81');
    expect(restoredExact.source).toContain('f93a85ebe5a509ccb7dfedb9be1ed3fa');
    expect(restoredExact.source).toContain('v_exact_seat_generation');

    expect(contraction.source).toContain(
      'fn_ca_settle_hand_stacks_absolute_pre_seat_exit_authority'
    );
    expect(contraction.source).toContain(
      "md5(v_settlement_core) <> '2c5f04ae307d38f187b8b72a3f557738'"
    );
    expect(contraction.source).toContain(
      "md5(v_settlement_door) <> 'a1738adaf943656868e68a7bf7ce8d1e'"
    );
    expect(contraction.source).toContain(
      "md5(v_settlement_wrapper) <> '9d6a12c82aa260c22e1c013e95faca0e'"
    );
    expect(contraction.source).toContain(
      "'Stage-B manager fencing found an unknown composed hand-settlement source'"
    );
    expect(contraction.source.indexOf('2c5f04ae307d38f187b8b72a3f557738')).toBeLessThan(
      contraction.source.indexOf('DROP FUNCTION IF EXISTS public.fn_ca_commit_hand_settlement(')
    );
  });

  it('pins the receipt preimages and their complete strict postimages', () => {
    for (const hash of [
      '2c5f04ae307d38f187b8b72a3f557738',
      'a1738adaf943656868e68a7bf7ce8d1e',
      '9d6a12c82aa260c22e1c013e95faca0e',
    ]) {
      expect(contraction.source).toContain(hash);
    }
    for (const [catalogValue, hash] of [
      ['v_inner', '9d1376a2b2e13e4dc1d25025b2d2e403'],
      ['v_inner_source', '3c2d594f08f52a66436f9a766947a1f1'],
      ['v_outer', '242f8a9d3ad57dac46cd8aa5b395b430'],
      ['v_outer_source', '9a3e7fccb42d396b4004b45672634e4f'],
    ]) {
      expect(contraction.source).toContain(`md5(${catalogValue}) <> '${hash}'`);
    }
    expect(contraction.source).toContain(
      'strict exact-seat settlement source changed after cutover'
    );
    expect(contraction.source).toContain(
      'strict exact-seat contraction requires the measured 20260910054712 production postimage'
    );
    expect(contraction.source).toContain('tournament_zero_stack_seat_generations');
    expect(contraction.source).toContain('post_commit_request_hash');
    expect(contraction.source).toContain('post_commit_payload_hash');
    expect(contraction.source).toContain(
      'public.fn_ca_share_settlement_lane_for_table(p_table_id)'
    );
  });

  it('carries exact identity through canonicalization, locking, writes and time banks', () => {
    expect(contraction.source).toContain("'seat_id', (x->>'seat_id')::uuid");
    expect(contraction.source).toContain("'seat_joined_at', x->>'seat_joined_at'");
    expect(contraction.source).toContain('WHERE ts.id = v_exact_seat_id');
    expect(contraction.source).toContain('AND ts.joined_at = v_exact_seat_joined_at');
    expect(contraction.source).toContain("WHERE ts.id = (e->>'seat_id')::uuid");
    expect(contraction.source).toContain("AND ts.joined_at = (e->>'seat_joined_at')::timestamptz");
    expect(contraction.source).toContain("AND s.id = (v_item->>'seat_id')::uuid");
    expect(contraction.source).toContain(
      "AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz"
    );
    expect(contraction.source).toContain('A SEAT THAT HAS LEFT CANNOT HOLD A TIME BANK');
    expect(contraction.source).toContain("OR position('v_exact_seat_generation' in v_outer) > 0");
    expect(contraction.source).toContain(
      'restored exact outer contraction produced an unknown source'
    );
  });

  it('keeps the direct stack core owner-only and the receipt door service-only', () => {
    expect(contraction.source).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(contraction.source).toContain(
      "a.grantee NOT IN (\n         p.proowner,\n         (SELECT oid FROM pg_roles WHERE rolname = 'service_role')"
    );
    expect(contraction.source).toContain('the direct stack implementation core is not owner-only');
    expect(contraction.source).toContain('the exact hand RPC has an unexpected executor');
  });
});
