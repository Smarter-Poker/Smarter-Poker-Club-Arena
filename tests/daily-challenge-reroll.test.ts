import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';

const rpc = vi.fn();
const emit = vi.fn();

vi.mock('../src/lib/supabase', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

vi.mock('../src/core/MasterBus', () => ({
  masterBus: { emit },
}));

const { dailyChallengeService } = await import('../src/services/DailyChallengeService');

const USER = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  rpc.mockReset();
  emit.mockReset();
});

describe('daily challenge rerolls', () => {
  it('calls the atomic RPC with the assignment the player actually saw', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        alreadyRerolled: false,
        challengeId: 'hp_25',
        diamondBalance: 490,
      },
      error: null,
    });

    await expect(dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10')).resolves.toEqual({
      success: true,
      alreadyRerolled: false,
      challengeId: 'hp_25',
      diamondBalance: 490,
    });
    expect(rpc).toHaveBeenCalledWith('reroll_daily_challenge', {
      p_user_id: USER,
      p_challenge_row_id: ROW,
      p_expected_challenge_id: 'hp_10',
      p_cost: 10,
    });
    expect(emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
      newBalance: 490,
      delta: -10,
      source: 'daily_challenge_reroll',
    });
  });

  it('treats a replay as success without announcing a second charge', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        alreadyRerolled: true,
        challengeId: 'hp_25',
        diamondBalance: 490,
      },
      error: null,
    });

    const result = await dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10');
    expect(result.alreadyRerolled).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      'DIAMOND_BALANCE_CHANGED',
      expect.objectContaining({ delta: 0 })
    );
  });

  it('never turns a refusal or missing RPC into a successful reroll', async () => {
    rpc.mockResolvedValueOnce({
      data: { success: false, error: 'not enough diamonds' },
      error: null,
    });
    await expect(dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10')).resolves.toMatchObject({
      success: false,
      error: 'not enough diamonds',
    });

    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: 'function reroll_daily_challenge does not exist' },
    });
    await expect(dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10')).resolves.toMatchObject({
      success: false,
    });
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('daily challenge batch claims', () => {
  it('keeps one request id and maps the exact next vault page receipt', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        replayed: false,
        claimedIds: [ROW],
        alreadyClaimedIds: [],
        chips: 750,
        diamonds: 10,
        diamondBalance: 500,
        stats: {
          totalClaimed: 4,
          totalChipsEarned: 2750,
          totalDiamondsEarned: 35,
        },
        vault: {
          count: 1,
          chips: 1000,
          diamonds: 15,
          pageSize: 100,
          hasMore: false,
          items: [
            {
              id: '33333333-3333-4333-8333-333333333333',
              challenge_id: 'straight_1',
              assigned_date: '2026-08-31',
              progress: 1,
              completed: true,
              claimed: false,
              name: 'Straight Away',
              description: 'Win A Hand With A Straight Or Better Today',
              challenge_type: 'straight_or_better',
              requirement: 1,
              chip_reward: 1000,
              diamond_reward: 15,
              tier: 'daily',
            },
          ],
        },
      },
      error: null,
    });

    const receipt = await dailyChallengeService.claimChallenges(USER, [ROW, ROW]);

    expect(rpc).toHaveBeenCalledWith('claim_daily_challenges', {
      p_user_id: USER,
      p_challenge_row_ids: [ROW],
      p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(receipt).toMatchObject({
      claimedIds: [ROW],
      chips: 750,
      diamonds: 10,
      diamondBalance: 500,
      vault: { count: 1, items: [{ challengeId: 'straight_1', tier: 'daily' }] },
    });
    expect(emit).toHaveBeenCalledWith('BALANCE_UPDATED', {
      source: 'daily_challenge_claim',
      userId: USER,
    });
    expect(emit).toHaveBeenCalledWith('DIAMOND_BALANCE_CHANGED', {
      newBalance: 500,
      delta: 10,
      source: 'daily_challenge_claim',
    });
  });
});

describe('reroll integrity is enforced below the UI', () => {
  const migration = readFileSync(
    resolve(__dirname, '../supabase/migrations/20260830220000_atomic_daily_challenge_reroll.sql'),
    'utf8'
  );
  const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION'));

  it('locks and verifies the expected assignment before spending diamonds', () => {
    const spend = body.indexOf('v_deduct := public.deduct_diamonds');
    expect(body.indexOf('FOR UPDATE')).toBeGreaterThan(-1);
    expect(body.indexOf('IS DISTINCT FROM p_expected_challenge_id')).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(-1);
    expect(body.indexOf('FOR UPDATE')).toBeLessThan(spend);
    expect(body.indexOf('IS DISTINCT FROM p_expected_challenge_id')).toBeLessThan(spend);
  });

  it('keeps the tier, rejects duplicates, and is not callable by anon', () => {
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.reroll_daily_challenge(uuid, integer)'
    );
    expect(body).toContain('c.tier = v_tier');
    expect(body).toContain('active.assigned_date = v_row.assigned_date');
    expect(body).toContain('active.challenge_id = c.id');
    expect(body).toContain('FROM PUBLIC, anon');
    expect(body).not.toContain('TO anon');
  });
});

describe('the page ships the casino-realism surface without the old stubs', () => {
  const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');
  const css = readFileSync(
    resolve(__dirname, '../src/pages/DailyChallengesPage.module.css'),
    'utf8'
  );
  const hero = resolve(__dirname, '../public/images/challenges/daily-missions-vault-v1.webp');

  it('uses the spendable balance and the real reroll service', () => {
    expect(page).toContain('dailyChallengeService.getDashboard(uid)');
    expect(page).toContain('setDiamondBalance(dashboard.diamondBalance)');
    expect(page).toContain('dailyChallengeService.rerollChallenge(');
    expect(page).toContain('diamondBalance < 5000');
    expect(page).not.toContain('(Mocked)');
    expect(page).not.toContain('window.confirm');
  });

  it('ships an optimized eager hero and responsive accessibility states', () => {
    expect(page).toContain('daily-missions-vault-v1.webp');
    expect(page).toContain('fetchPriority="high"');
    expect(css).not.toContain('@import url(');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    expect(statSync(hero).size).toBeLessThan(200 * 1024);
  });

  it('keeps dashboard failures recoverable and refreshes stale background tabs', () => {
    expect(page).toContain('dailyChallengeService.getDashboard(uid)');
    expect(page).toContain("document.addEventListener('visibilitychange'");
    expect(page).toContain('requestId !== loadRequestRef.current');
    expect(page).toContain('if (!initialLoadSettledRef.current) return;');
    expect(page).toContain('MissionLoadingState');
    expect(page).toContain('Retry Mission Link');
  });

  it('ships complete reward feedback and keyboard-operable period tabs', () => {
    expect(page).toContain('reward.chips.toLocaleString()');
    expect(page).toContain('aria-controls={`mission-panel-${tier}`}');
    expect(page).toContain("event.key === 'ArrowRight'");
    expect(page).toContain('Current Progress Will Be Replaced');
  });
});
