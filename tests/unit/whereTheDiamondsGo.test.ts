/**
 * Phase 5: where the diamonds go. DiamondService.getDiamondFlow parses the
 * RPC honestly and returns null on failure; the panel math picks the lines
 * that carry diamonds and sizes each bar as a share of its side; the panel is
 * wired into the Earn tab; the migration and its manifest fragment agree.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

const { DiamondService } = await import('../../src/services/DiamondService');
const { linesFor, shareOf } = await import('../../src/components/wallet/diamondFlowMath');

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const payload = {
  user_id: 'u-1',
  spent: [
    {
      bucket: 'arena',
      label: 'Diamond Arena Seats',
      lifetime: 800,
      lifetime_count: 10,
      last30: '160',
      last30_count: 2,
    },
    {
      bucket: 'games',
      label: 'Games And Arcade',
      lifetime: 180,
      lifetime_count: 9,
      last30: 10,
      last30_count: 1,
    },
  ],
  earned: [
    {
      bucket: 'rewards',
      label: 'Daily Rewards And Challenges',
      lifetime: 5719,
      lifetime_count: 137,
      last30: 1705,
      last30_count: 36,
    },
  ],
  spent_total: 980,
  earned_total: '5719',
  spent_last30: 170,
  earned_last30: 1705,
  read_at: '2026-09-14T11:15:00Z',
};

describe('DiamondService.getDiamondFlow', () => {
  beforeEach(() => rpc.mockReset());

  it('calls fn_diamond_flow_by_kind with no arguments (own user only) and maps every line', async () => {
    rpc.mockResolvedValueOnce({ data: payload, error: null });
    const f = await DiamondService.getDiamondFlow();
    expect(rpc).toHaveBeenCalledWith('fn_diamond_flow_by_kind');
    expect(f).toEqual({
      spent: [
        {
          bucket: 'arena',
          label: 'Diamond Arena Seats',
          lifetime: 800,
          lifetimeCount: 10,
          last30: 160,
          last30Count: 2,
        },
        {
          bucket: 'games',
          label: 'Games And Arcade',
          lifetime: 180,
          lifetimeCount: 9,
          last30: 10,
          last30Count: 1,
        },
      ],
      earned: [
        {
          bucket: 'rewards',
          label: 'Daily Rewards And Challenges',
          lifetime: 5719,
          lifetimeCount: 137,
          last30: 1705,
          last30Count: 36,
        },
      ],
      spentTotal: 980,
      earnedTotal: 5719,
      spentLast30: 170,
      earnedLast30: 1705,
      readAt: '2026-09-14T11:15:00Z',
    });
  });

  it('accepts the RPC result wrapped in an array', async () => {
    rpc.mockResolvedValueOnce({ data: [payload], error: null });
    const f = await DiamondService.getDiamondFlow();
    expect(f?.spentTotal).toBe(980);
  });

  it('returns null, never zeros, when the RPC errors', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied' } });
    expect(await DiamondService.getDiamondFlow()).toBeNull();
  });

  it('returns null when the payload is missing a bucket list or names no bucket', async () => {
    rpc.mockResolvedValueOnce({ data: { ...payload, earned: undefined }, error: null });
    expect(await DiamondService.getDiamondFlow()).toBeNull();
    rpc.mockResolvedValueOnce({
      data: { ...payload, spent: [{ label: 'Nameless', lifetime: 1 }] },
      error: null,
    });
    expect(await DiamondService.getDiamondFlow()).toBeNull();
    rpc.mockResolvedValueOnce({ data: { ...payload, spent_total: 'lots' }, error: null });
    expect(await DiamondService.getDiamondFlow()).toBeNull();
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await DiamondService.getDiamondFlow()).toBeNull();
  });
});

describe('the panel math', () => {
  const lines = [
    {
      bucket: 'gifts_sent',
      label: 'Gifts To Friends',
      lifetime: 200,
      lifetimeCount: 4,
      last30: 0,
      last30Count: 0,
    },
    {
      bucket: 'arena',
      label: 'Diamond Arena Seats',
      lifetime: 800,
      lifetimeCount: 10,
      last30: 160,
      last30Count: 2,
    },
    {
      bucket: 'games',
      label: 'Games And Arcade',
      lifetime: 200,
      lifetimeCount: 9,
      last30: 40,
      last30Count: 3,
    },
  ];

  it('lists the lines that carry diamonds in the window, largest first, ties by bucket', () => {
    expect(linesFor(lines, 'lifetime').map((l) => l.bucket)).toEqual([
      'arena',
      'games',
      'gifts_sent',
    ]);
    expect(linesFor(lines, 'last30').map((l) => l.bucket)).toEqual(['arena', 'games']);
  });

  it('sizes a bar as the share of its side and never past the edges', () => {
    expect(shareOf(lines[1], 1200, 'lifetime')).toBeCloseTo(66.67, 1);
    expect(shareOf(lines[1], 200, 'last30')).toBe(80);
    expect(shareOf(lines[1], 0, 'lifetime')).toBe(0);
    expect(shareOf(lines[1], 100, 'lifetime')).toBe(100);
  });
});

describe('the wiring', () => {
  it('the Earn tab renders the panel with the signed-in user', () => {
    const page = read('src/pages/PlayerWalletPage.tsx');
    expect(page).toContain("import DiamondFlowPanel from '../components/wallet/DiamondFlowPanel';");
    const earn = page.slice(
      page.indexOf("activeTab === 'earn' &&"),
      page.indexOf("activeTab === 'history' &&")
    );
    expect(earn).toContain('Where Your Diamonds Go');
    expect(earn).toContain('<DiamondFlowPanel userId={user?.id} />');
  });

  it('the migration declares both functions, reads the whole ledger, and is own-user only', () => {
    const migration = read('supabase/migrations/20260914110559_where_the_diamonds_go.sql');
    const body = migration.slice(migration.indexOf('BEGIN;'));
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(');
    expect(body).toContain('CREATE OR REPLACE FUNCTION public.fn_diamond_flow_by_kind(');
    /* The kind map production runs is the later same-day redefinition in
       20260914114052 (every writer named); the flow function is unchanged
       and still lives here. The kind resolution below is pinned on the live
       version. */
    const liveMap = read(
      'supabase/migrations/20260914114052_the_diamond_kind_map_names_every_writer.sql'
    );
    expect(liveMap).toContain('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket(');
    expect(liveMap).toContain("NULLIF(BTRIM(p_transaction_type), '')");
    expect(liveMap).toContain("THEN 'other_spent'");
    expect(liveMap).toContain("ELSE 'other_earned'");
    expect(liveMap).toMatch(/^IMMUTABLE$/m);
    expect(liveMap).not.toMatch(/\bFROM public\./);
    expect(liveMap.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(liveMap.match(/^COMMIT;/gm)).toHaveLength(1);
    expect(body).toContain("RAISE EXCEPTION 'diamond_flow_is_own_only'");
    expect(body).toContain('FROM public.diamond_transactions t');
    expect(body).toContain("interval '30 days'");
    // Read only: STABLE, nothing written, nothing repaired.
    expect(body).toMatch(/RETURNS jsonb\s+LANGUAGE plpgsql\s+STABLE/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    // Anonymous callers cannot read anyone's ledger.
    expect(body).toContain(
      'REVOKE ALL ON FUNCTION public.fn_diamond_flow_by_kind(uuid) FROM PUBLIC, anon;'
    );
    // The kind resolution reads transaction_type first, then type; every
    // ledger row lands in a bucket (ELSE arms on both sides).
    expect(body).toContain("NULLIF(BTRIM(p_transaction_type), '')");
    expect(body).toContain("THEN 'other_spent'");
    expect(body).toContain("ELSE 'other_earned'");
    // Exactly one transaction.
    expect(body.match(/^BEGIN;/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;/gm)).toHaveLength(1);
  });

  it('the live map names every kind a writer can produce, exactly (deep dive 2026-09-14)', () => {
    // Read from production on 2026-09-14: every function that inserts into
    // diamond_transactions (24 of them), diamond_reward_catalog.action_key
    // (33 keys), and the kinds the Mint register classifies. A kind that can
    // reach the ledger is named here as an exact literal, never left to a
    // pattern: add a writer, add its kind to the map, or this test says so.
    const writerKinds = [
      // spent
      'arena_deposit',
      'tournament_fee',
      'diamond_gift_sent',
      'live_gift_sent',
      'chip_purchase',
      'chip_mint',
      'plinko_drop',
      'crash_bet',
      'wheel_spin',
      'pvp_stake',
      'game_cost',
      'memory_game',
      'trivia_entry',
      'trivia_arcade',
      'trivia_lifeline',
      'training_entry',
      'tournament_entry',
      'daily_challenge_reroll',
      'feature_purchase',
      'feature_unlock',
      'video_unlock',
      'streak_freeze',
      'refund',
      'debt_settlement',
      'adjustment',
      'reconciliation',
      'burn',
      // earned
      'arena_withdraw',
      'diamond_gift_received',
      'live_gift_received',
      'transfer',
      'union_grant',
      'purchase',
      'purchased',
      'stripe_purchase',
      'diamond_purchase',
      'purchase_clearing',
      'mint',
      'daily_login',
      'daily_bonus',
      'daily_bonus_boost',
      'daily_challenge_claim',
      'daily_mission_milestone',
      'daily_trivia_challenge',
      'streak_reward',
      'challenge',
      'achievement',
      'hand_of_the_day',
      'gto_chart_study',
      'training_reward',
      'training_level_complete',
      'first_training_session',
      'trivia_run',
      'trivia_daily_bonus',
      'trivia_prize_wheel',
      'wheel_prize',
      'signup_bonus',
      'bonus',
      'promotional',
      'easter_egg',
      'birthday',
      'first_purchase',
      'referral_bonus',
      'referral_qualified',
      'referral_referee',
      'referral_vip_conversion',
      'tournament_prize',
      'pvp_win',
      'vip_stipend',
      'vip_daily',
      'social_post',
      'follow',
      'reaction',
      'strategy_comment',
      'share_content',
      'profile_complete',
      'profile_pic',
      'video_watch',
      'video_favorite',
      'hendonmob_link',
      'venue_review',
      'email_verified',
      'phone_verified',
      'pvp_refund',
      'pvp_tie_refund',
      'diamond_gift_refund',
      'tournament_cancel_refund',
      'tournament_entry_refund',
      'admin',
      'seeded',
      'bridge',
      'house',
    ];
    const migration = read(
      'supabase/migrations/20260914114052_the_diamond_kind_map_names_every_writer.sql'
    );
    const map = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_diamond_kind_bucket'),
      migration.indexOf('COMMENT ON FUNCTION public.fn_diamond_kind_bucket')
    );
    const missing = writerKinds.filter((k) => !map.includes(`'${k}'`));
    expect(missing).toEqual([]);
    // Same signature as the first migration: nothing that calls it changes.
    expect(map).toContain('p_type             text,');
    expect(map).toContain('p_amount           bigint');
    expect(map).toContain('RETURNS TABLE (kind text, bucket text, label text)');
    // Pure: IMMUTABLE, no table reads, both sides end in Other.
    expect(map).toMatch(/LANGUAGE sql\s+IMMUTABLE\s+PARALLEL SAFE/);
    expect(map).not.toMatch(/FROM public\./);
    expect(map).toContain("THEN 'other_spent'");
    expect(map).toContain("ELSE 'other_earned'");
    // Every bucket the map can name has a player-facing label.
    const buckets = new Set([...map.matchAll(/THEN '([a-z_]+)'/g)].map((m) => m[1]));
    const labelled = new Set([...map.matchAll(/WHEN '([a-z_]+)'\s+THEN '[A-Z]/g)].map((m) => m[1]));
    for (const b of buckets) {
      if (b === 'other_spent' || b === 'other_earned') continue;
      expect(labelled.has(b), `bucket ${b} has no label`).toBe(true);
    }
  });

  it('the schema-manifest fragment names both functions', () => {
    const fragment = JSON.parse(
      read('scripts/ci/schema-manifest.d/cw-wallet-where-the-diamonds-go.json')
    );
    expect(fragment.functions).toEqual(['fn_diamond_kind_bucket', 'fn_diamond_flow_by_kind']);
  });
});
