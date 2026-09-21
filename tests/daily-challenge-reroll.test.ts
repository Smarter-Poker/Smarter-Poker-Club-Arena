import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { readDailyChallengesUnit } from './helpers/dailyChallengesSources';

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

const { DAILY_MISSION_REROLL_COST, dailyChallengeService } =
  await import('../src/services/DailyChallengeService');

const USER = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';
const REROLLED_CHALLENGE = {
  id: ROW,
  challenge_id: 'hp_25',
  assigned_date: '2026-09-06',
  progress: 0,
  completed: false,
  claimed: false,
  completed_at: null,
  name: 'Warmed Up',
  description: 'Play 25 Hands Today',
  challenge_type: 'hands_played',
  requirement: 25,
  diamond_reward: 12,
  tier: 'daily',
};

beforeEach(() => {
  rpc.mockReset();
  emit.mockReset();
});

describe('daily challenge rerolls', () => {
  it('calls the atomic RPC with the assignment the player actually saw', async () => {
    rpc.mockImplementation((_name: string, params: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          success: true,
          alreadyRerolled: false,
          requestId: params.p_request_id,
          diamondsSpent: DAILY_MISSION_REROLL_COST,
          challengeId: 'hp_25',
          diamondBalance: 499,
          challenge: REROLLED_CHALLENGE,
        },
        error: null,
      })
    );

    await expect(dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10')).resolves.toMatchObject({
      success: true,
      alreadyRerolled: false,
      diamondsSpent: 1,
      challengeId: 'hp_25',
      diamondBalance: 499,
    });
    expect(rpc).toHaveBeenCalledWith('reroll_daily_challenge', {
      p_user_id: USER,
      p_challenge_row_id: ROW,
      p_expected_challenge_id: 'hp_10',
      p_cost: DAILY_MISSION_REROLL_COST,
      p_request_id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it('acknowledges a replay without publishing its potentially stale projection', async () => {
    rpc.mockImplementation((_name: string, params: Record<string, unknown>) =>
      Promise.resolve({
        data: {
          success: true,
          alreadyRerolled: true,
          requestId: params.p_request_id,
          diamondsSpent: 0,
          challengeId: 'hp_25',
          diamondBalance: 499,
          challenge: REROLLED_CHALLENGE,
        },
        error: null,
      })
    );

    const result = await dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10');
    expect(result).toEqual({ success: true, alreadyRerolled: true, diamondsSpent: 0 });
    expect(emit).not.toHaveBeenCalled();
  });

  it('reuses one request id when PostgreSQL selects it as a deadlock victim', async () => {
    const requestIds: unknown[] = [];
    rpc
      .mockImplementationOnce((_name: string, params: Record<string, unknown>) => {
        requestIds.push(params.p_request_id);
        return Promise.resolve({
          data: null,
          error: { code: '40P01', message: 'deadlock detected' },
        });
      })
      .mockImplementationOnce((_name: string, params: Record<string, unknown>) => {
        requestIds.push(params.p_request_id);
        return Promise.resolve({
          data: {
            success: true,
            alreadyRerolled: true,
            requestId: params.p_request_id,
            diamondsSpent: 0,
            challengeId: 'hp_25',
            diamondBalance: 499,
            challenge: REROLLED_CHALLENGE,
          },
          error: null,
        });
      });

    await expect(dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10')).resolves.toMatchObject({
      success: true,
      alreadyRerolled: true,
    });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[0]).toBe(requestIds[1]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a receipt that is not bound to this reroll request', async () => {
    rpc.mockResolvedValue({
      data: {
        success: true,
        alreadyRerolled: false,
        requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        diamondsSpent: DAILY_MISSION_REROLL_COST,
        challengeId: 'hp_25',
        diamondBalance: 499,
        challenge: REROLLED_CHALLENGE,
      },
      error: null,
    });

    const result = await dailyChallengeService.rerollChallenge(USER, ROW, 'hp_10');
    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid reroll request identifier receipt');
    expect(emit).not.toHaveBeenCalled();
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
        // The RPC still emits `chips`, always 0 since migration 20260905114421.
        // The fixture keeps it non-zero deliberately: the assertion below is
        // that the client DROPS it rather than that the server stopped sending.
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
              completed_at: '2026-08-31T12:00:00.000Z',
              claimed: false,
              name: 'Straight Away',
              description: 'Win A Hand With A Straight Or Better Today',
              challenge_type: 'strong_hands',
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
      diamonds: 10,
      diamondBalance: 500,
      vault: { count: 1, items: [{ challengeId: 'straight_1', tier: 'daily' }] },
    });
    // A mission reward is diamonds (Dan 2026-09-05). Nothing on the receipt,
    // its lifetime stats or its vault page carries a chip figure any more.
    expect(receipt).not.toHaveProperty('chips');
    expect(receipt.stats).not.toHaveProperty('totalChipsEarned');
    expect(receipt.vault).not.toHaveProperty('chips');
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
  const hero = resolve(__dirname, '../public/images/challenges/daily-missions-casino-v2.webp');
  const mobileHero = resolve(
    __dirname,
    '../public/images/challenges/daily-missions-casino-v2-mobile.webp'
  );

  it('uses the spendable balance and the real reroll service', () => {
    expect(page).toContain('dailyChallengeService.getDashboard(uid)');
    expect(page).toContain('setDiamondBalance(dashboard.diamondBalance)');
    expect(page).toContain('dailyChallengeService.rerollChallenge(');
    expect(page).toContain('diamondBalance < 5000');
    expect(page).not.toContain('(Mocked)');
    expect(page).not.toContain('window.confirm');
  });

  it('ships an optimized eager hero and responsive accessibility states', () => {
    expect(page).toContain('daily-missions-casino-v2.webp');
    expect(page).toContain('daily-missions-casino-v2-mobile.webp');
    expect(page).toContain('fetchPriority="high"');
    expect(css).not.toContain('@import url(');
    expect(css).toContain('@media (max-width: 680px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
    expect(statSync(hero).size).toBeLessThan(200 * 1024);
    expect(statSync(mobileHero).size).toBeLessThan(100 * 1024);
  });

  it('keeps dashboard failures recoverable and refreshes stale background tabs', () => {
    expect(page).toContain('dailyChallengeService.getDashboard(uid)');
    expect(page).toContain("document.addEventListener('visibilitychange'");
    expect(page.match(/!isCurrentDailyMissionDashboardReceipt\(/g)).toHaveLength(2);
    expect(page).toContain('mutationEpochRef.current += 1');
    expect(page).toContain('if (!initialLoadSettledRef.current) return;');
    expect(page).toContain('const acceptedAt = Date.now();');
    // A resumed tab asks the durable revision cursor whether it is stale; a
    // wall-clock guess about the last receipt no longer decides a full reload.
    expect(page).not.toContain('lastDashboardReceiptAtRef');
    expect(page).not.toContain('60_000');
    expect(page).toContain('requestCursorCatchUp();');
    expect(page).toContain('const serverSyncedAt = Date.parse(dashboard.syncedAt);');
    expect(page).toContain('const nextServerClockOffsetMs = serverSyncedAt - acceptedAt;');
    expect(page).toContain('periodKeysRef.current = dashboard.periodKeys;');
    expect(page).toContain("msUntilChallengeReset('daily', serverNow)");
    expect(page).toContain('getUtcDateKey(resumedAt + clockOffset) !== renderedDailyKey');
    expect(page).not.toContain('lastSyncedAtRef');
    expect(page).not.toContain('dateKeyRef');
    expect(page).toContain('MissionLoadingState');
    expect(readDailyChallengesUnit('MissionSyncNotice.tsx')).toContain('Retry Sync');
  });

  it('distinguishes an unreadable secure session from a signed-out visitor', () => {
    expect(page).toContain('const authResult = await getAuthUser();');
    expect(page).toContain("authResult.error || ('failed' in authResult && authResult.failed)");
    expect(page).toContain('Secure Session Check Failed. Please Retry Or Sign In Again.');
    expect(page).toContain('Retry Session Check');
  });

  it('blocks push enrollment when the current browser cannot support it', () => {
    expect(page).toContain('const unsupportedBrowser = !isWebPushSupported() && !unsupportedIos;');
    expect(page).toContain(
      "const enrollmentBlocked = permission === 'denied' || unsupportedIos || unsupportedBrowser;"
    );
    expect(page).toContain('Unavailable In This Browser');
    expect(page).toContain(
      'This Browser Does Not Support Challenge Alerts. Use A Supported Browser Or Device.'
    );
  });

  it('ships complete reward feedback and keyboard-operable period tabs', () => {
    // Was `reward.chips.toLocaleString()`. The celebration no longer has a
    // chip payout tile to render (Dan 2026-09-05: rewards are diamonds).
    expect(page).toContain('reward.diamonds.toLocaleString()');
    expect(readDailyChallengesUnit('MissionCycleRail.tsx')).toContain(
      'aria-controls="mission-panel"'
    );
    expect(page).toContain("event.key === 'ArrowRight'");
    const card = readDailyChallengesUnit('MissionCard.tsx');
    expect(card).toContain('{DAILY_MISSION_REROLL_COST} Diamond? Current Progress Will Be');
    expect(card).toContain('Replaced.');
  });
});
