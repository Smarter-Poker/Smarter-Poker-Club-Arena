/**
 * THE CLUB BANK OVERLAY IS AN EXPLICIT OWNER OPT-IN, AND THE OPENING SEED IS
 * FUNDING (owner brief 8.3, migration 20260923143157).
 *
 * "Paid leaderboards: first-round funding is explicitly seeded. Later rounds
 *  use Promotion funds. Any insufficient Promotion amount becomes an explicit
 *  club-wallet overlay."
 *
 * The migration was qualified against an isolated PostgreSQL 17 fixture built
 * from the live definitions (the scenario SQL lives with the evidence, not in
 * this repo). This suite pins the clauses that make it true in the file that
 * ships, and the client half: the overlay flag travels only when the owner
 * chose it, and a paid batch reconciles as seed + promo + overlay.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), report: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/utils/retryAsync', () => ({
  retryAsync: async <T>(fn: () => Promise<T>) => fn(),
}));

import { LeaderboardService } from '../../src/services/LeaderboardService';

const migrations = resolve(__dirname, '../../supabase/migrations');
const bySlug = (slug: string) => {
  const file = readdirSync(migrations)
    .filter((name) => name.includes(slug))
    .sort()
    .pop();
  expect(file, `the ${slug} migration is missing`).toBeTruthy();
  return readFileSync(resolve(migrations, file as string), 'utf8');
};
const A = bySlug('the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl');
const B = bySlug('a_standalone_club_with_no_opening_seed_settles_with_a_seed_o');
/** One function's statement out of a migration file. */
const statement = (sql: string, fn: string) => {
  const start = sql.search(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\(`)
  );
  expect(start, `${fn} is not declared here`).toBeGreaterThan(-1);
  const open = sql.indexOf('$function$', start);
  return sql.slice(start, sql.indexOf('$function$', open + 10) + 10);
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockReset();
});

describe('the migration that ships it', () => {
  it('is one transaction with a lock timeout, asserting the live definitions it replaces', () => {
    expect(A).toMatch(/^BEGIN;\nSET LOCAL lock_timeout = '5s';/m);
    expect(A.trim().endsWith('COMMIT;')).toBe(true);
    for (const liveMd5 of [
      'a968ef67eac488895f9db21b9aaa6459', // fn_complete_club_opening_setup
      'cc9e35b7128794dac8d46e31a8ba5a76', // fn_publish_leaderboard_reward_program
      'b8b042dd2f5c4b316cfdd3798e753d2d', // fn_save_leaderboard_reward_setup
      'aa4c5583f4ccda6bd7f251f40522674b', // fn_enforce_leaderboard_program_funding
      '8b9c1773e3b5d6732cb98ba94be280d7', // fn_payout_leaderboard
      '9016d6a91750cbfb5a8eae383f8b66b8', // fn_get_leaderboard_reward_setup
      'c123aaf0e0a7560a7af5c884c13c01ed', // fn_get_leaderboard_settlement_status
    ]) {
      expect(A).toContain(liveMd5);
    }
    expect(A).toContain('LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT');
    expect(A).toContain('LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT');
  });

  it('adds the per-program opt-in OFF for every existing program, and only for a paid standalone club', () => {
    expect(A).toContain('ADD COLUMN overlay_enabled boolean NOT NULL DEFAULT false');
    expect(A).toMatch(
      /CHECK \(NOT overlay_enabled\s+OR \(rewards_enabled AND funding_owner_type = 'club' AND funding_union_id IS NULL\)\)/
    );
    expect(A).toContain('DROP CONSTRAINT leaderboard_payout_batches_promo_only_check');
    expect(A).toContain("CHECK (overlay_funded = 0 OR funding_owner_type = 'club')");
  });

  it('recreates both publication functions and the opening RPC with one overload each', () => {
    expect(A).toContain(
      'DROP FUNCTION public.fn_publish_leaderboard_reward_program(uuid, boolean, text, jsonb, jsonb, text, integer, uuid);'
    );
    expect(A).toContain(
      'DROP FUNCTION public.fn_save_leaderboard_reward_setup(uuid, boolean, text, jsonb, jsonb, text, integer, uuid);'
    );
    expect(A).toMatch(/DROP FUNCTION public\.fn_complete_club_opening_setup\(/);
    expect(statement(A, 'fn_publish_leaderboard_reward_program')).toContain(
      'p_overlay_enabled boolean DEFAULT false'
    );
    expect(statement(A, 'fn_save_leaderboard_reward_setup')).toContain(
      'p_overlay_enabled boolean DEFAULT false'
    );
    expect(statement(A, 'fn_complete_club_opening_setup')).toContain(
      'p_leaderboard_overlay_enabled boolean DEFAULT false'
    );
    // Grants restated in the same transaction, exactly the live ones.
    expect(A).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_publish_leaderboard_reward_program\([^)]*boolean\s*\) FROM PUBLIC, anon, authenticated;/
    );
    expect(A).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_save_leaderboard_reward_setup\([^)]*boolean\s*\) TO authenticated, service_role;/
    );
    expect(A).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_complete_club_opening_setup\([^)]*boolean\s*\) TO authenticated, service_role;/
    );
  });

  it('counts the opening seed for the opening publication only', () => {
    const gate = statement(A, 'fn_enforce_leaderboard_program_funding');
    expect(gate).toContain('AND setup.last_operation_id = NEW.operation_id');
    expect(gate).toContain('v_balance := v_balance + COALESCE(v_opening_seed, 0);');
    const opening = statement(A, 'fn_complete_club_opening_setup');
    expect(opening.indexOf('INSERT INTO public.club_opening_setups (')).toBeLessThan(
      opening.indexOf('v_leaderboard_result := public.fn_publish_leaderboard_reward_program(')
    );
  });

  it('publishes against the current version, from the owner only', () => {
    const opening = statement(A, 'fn_complete_club_opening_setup');
    expect(opening).toContain('SELECT COALESCE(max(program.version), 0)');
    expect(opening).toMatch(
      /'balanced',\s*v_program_version,\s*p_operation_id,\s*v_leaderboard_overlay\s*\)/
    );
    expect(opening).not.toContain('v_is_platform_admin');
    expect(opening).toMatch(
      /IF v_club\.owner_id IS DISTINCT FROM v_actor THEN\s*RAISE EXCEPTION 'Only The Club Owner Can Complete Opening Setup'\s*USING ERRCODE = '42501';/
    );
  });

  it('hashes the opt-in only when it is ON, so every other program hashes as before', () => {
    const publish = statement(A, 'fn_publish_leaderboard_reward_program');
    expect(publish).toContain(
      "THEN jsonb_build_object('overlay_enabled', true) ELSE '{}'::jsonb END;"
    );
    expect(publish.match(/\) \|\| v_overlay_terms\)::text\);/g)).toHaveLength(2);
    expect(publish).toContain("RAISE EXCEPTION 'A Club Bank Overlay Needs A Paid Leaderboard'");
    expect(publish).toContain('A Club Bank Overlay Is Only Available To A Standalone Club');
  });

  it('holds the no-setup-row seed correction as its own migration, applied after this one', () => {
    expect(B).toContain('APPLY AFTER 20260923143157');
    expect(B).toContain("md5(p.prosrc) = 'b311250f543badd00a461b461cf2b591'");
    const payout = statement(B, 'fn_payout_leaderboard');
    expect(payout).toMatch(
      /FOR UPDATE;\s*(?:--[^\n]*\n\s*)*v_seed_available := COALESCE\(v_seed_available, 0\);/
    );
    expect(payout).not.toContain('IF v_overlay_enabled THEN');
    // A, on its own, keeps today's arithmetic for every program without the opt-in.
    expect(statement(A, 'fn_payout_leaderboard')).toMatch(
      /IF v_overlay_enabled THEN\s*(?:--[^\n]*\n\s*)*v_seed_available := COALESCE\(v_seed_available, 0\);\s*END IF;/
    );
  });
});

describe('the publication service carries the owner answer', () => {
  const plan = {
    rewards_enabled: true,
    payout_metric: 'profit' as const,
    weekly_prizes: [{ rank: 1, amount: 300 }],
    monthly_prizes: [],
    suggestion_key: 'custom' as const,
    program_version: 1,
  };

  it('sends the opt-in as a ninth argument only when it is ON', async () => {
    mocks.rpc.mockResolvedValue({ data: { club_id: 'club-1', program_version: 2 }, error: null });
    await LeaderboardService.saveLeaderboardRewardSetup('club-1', {
      ...plan,
      overlay_enabled: true,
    });
    expect(mocks.rpc.mock.calls[0][0]).toBe('fn_save_leaderboard_reward_setup');
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_overlay_enabled: true });
    expect(Object.keys(mocks.rpc.mock.calls[0][1])).toHaveLength(9);

    for (const overlay of [false, undefined]) {
      mocks.rpc.mockClear();
      await LeaderboardService.saveLeaderboardRewardSetup('club-1', {
        ...plan,
        overlay_enabled: overlay,
      });
      expect(mocks.rpc.mock.calls[0][1]).not.toHaveProperty('p_overlay_enabled');
      expect(Object.keys(mocks.rpc.mock.calls[0][1])).toHaveLength(8);
    }
  });
});

describe('a paid batch reconciles as seed + promo + overlay', () => {
  const status = (batch: Record<string, unknown>) => ({
    club_id: 'club-1',
    period: 'weekly',
    period_start: '2026-09-13',
    period_end: '2026-09-20',
    state: 'paid',
    can_manage: true,
    planned_total: '300.00',
    program: null,
    batch: {
      id: 'batch-1',
      program_id: 'program-1',
      program_version: '1',
      program_hash: 'hash',
      metric: 'profit',
      funding_owner_type: 'club',
      funding_union_id: null,
      total_paid: '300.00',
      seed_funded: '0.00',
      promo_funded: '120.00',
      overlay_funded: '180.00',
      winner_count: '1',
      tie_policy: 'split_occupied_places',
      settled_at: '2026-09-21T00:20:00Z',
      ...batch,
    },
    failure: null,
    receipts: [
      {
        id: 'receipt-1',
        batch_id: 'batch-1',
        user_id: 'player-1',
        rank: '1',
        payout_amount: '300.00',
        payout_currency: 'chips',
        awarded_at: '2026-09-21T00:20:00Z',
      },
    ],
  });
  const read = () =>
    LeaderboardService.getLeaderboardSettlementStatus('club-1', 'weekly', '2026-09-13');

  it('accepts and normalizes a round the Club Bank topped up', async () => {
    mocks.rpc.mockResolvedValue({ data: status({}), error: null });
    const result = await read();
    expect(result.batch).toMatchObject({ promo_funded: 120, overlay_funded: 180, total_paid: 300 });
  });

  it('treats a server that predates the overlay as an overlay of 0', async () => {
    mocks.rpc.mockResolvedValue({
      data: status({ promo_funded: '300.00', overlay_funded: undefined }),
      error: null,
    });
    const result = await read();
    expect(result.batch?.overlay_funded).toBe(0);
  });

  it('refuses a batch whose funding does not add up, or a union batch with an overlay', async () => {
    mocks.rpc.mockResolvedValue({ data: status({ overlay_funded: '170.00' }), error: null });
    await expect(read()).rejects.toThrow('Leaderboard Settlement Batch Returned Invalid Data');
    mocks.rpc.mockResolvedValue({
      data: status({ funding_owner_type: 'union', funding_union_id: 'union-1' }),
      error: null,
    });
    await expect(read()).rejects.toThrow('Leaderboard Settlement Batch Returned Invalid Data');
    mocks.rpc.mockResolvedValue({ data: status({ overlay_funded: '-5' }), error: null });
    await expect(read()).rejects.toThrow('Leaderboard Settlement Batch Returned Invalid Data');
  });
});
