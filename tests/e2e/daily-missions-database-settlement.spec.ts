import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

import {
  callServiceRpc,
  cleanupTemporaryCustomizationAccount,
  createTemporaryCustomizationAccount,
  deleteServiceRows,
  insertServiceRows,
  readServiceRows,
  requireCustomizationCertificationEnvironment,
  updateServiceRows,
  type CustomizationCertificationEnvironment,
  type TemporaryCustomizationAccount,
} from './support/temporaryCustomizationAccount';

const CERTIFICATION_ENABLED = process.env.DAILY_MISSIONS_CERTIFICATION === '1';
const RESPONSE_LOSS_MUTATION_DIAMONDS = 37;
const HISTORICAL_MILESTONE_RAW_DIAMONDS = 10;
const HISTORICAL_MILESTONE_ACTUAL_DIAMONDS = 15;

type JsonObject = Record<string, unknown>;

type DailyChallengeContract = {
  assignmentId: string;
  assignedDate: string;
  id: string;
  requirement: number;
  diamond_reward: number;
};

type CanonicalDailyChallengeRow = {
  id: string;
  challenge_id: string;
  challenge_type_snapshot: string;
  requirement_snapshot: number;
  diamond_reward_snapshot: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  assigned_date: string;
};

type DailyChallengeRow = {
  id: string;
  assigned_date: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  diamond_reward_snapshot: number;
};

type DailyChallengeMilestone = {
  days: number;
  reward_diamonds: number;
};

type DailyChallengeMilestoneClaim = {
  user_id: string;
  streak_run_id: string;
  streak_started_on: string;
  milestone_days: number;
  reward_diamonds: number;
  claimed_at: string;
};

type DailyChallengeClaimBatch = {
  user_id: string;
  request_id: string;
  challenge_row_ids: string[];
  result: JsonObject;
  created_at: string;
};

type DiamondTransaction = {
  id?: string;
  amount: number;
  transaction_type: string;
  type: string;
  balance_after: number;
  reference_id: string;
  metadata: JsonObject;
  created_at: string;
};

type ChallengeStreakState = {
  freezes_available: number;
  freezes_used: number;
  freezes_earned: number;
  frozen_dates: string[];
  current_streak_run_id: string | null;
  current_streak_started_on: string | null;
  current_streak_ended_on: string | null;
  current_streak_length: number | null;
  updated_at: string;
};

type ClaimReceipt = JsonObject & {
  success: boolean;
  replayed: boolean;
  claimedIds: string[];
  alreadyClaimedIds: string[];
  diamonds: number;
  challengeDiamonds: number;
  milestoneDiamonds: number;
  diamondsCredited: number;
  diamondBalance: number;
  settlementDiamondBalance: number;
  settlementVersion: number;
  stats: {
    totalClaimed: number;
    totalDiamondsEarned: number;
  };
};

type DashboardReceipt = JsonObject & {
  diamondBalance: number;
  periodKeys: {
    daily: string;
  };
  stats: {
    totalClaimed: number;
    totalDiamondsEarned: number;
  };
};

type StreakReceipt = JsonObject & {
  streak: number;
  streakRunId: string;
  streakStartedOn: string;
  streakEndedOn: string;
  freezesAvailable: number;
  usedFreeze: boolean;
  frozenDate: string | null;
  lastFrozenDate: string | null;
  honoredFrozenDates: number;
  consumedFreeze: boolean;
  consumedFrozenDate: string | null;
  freezeReceiptVersion: number;
};

function query(select: string, filters: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ select, ...filters });
}

function utcDateOffset(offsetDays: number, origin = new Date()): string {
  const value = new Date(origin);
  value.setUTCHours(12, 0, 0, 0);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function numeric(value: unknown): number {
  const result = Number(value);
  expect(Number.isFinite(result), `Expected A Finite Number, Received ${String(value)}`).toBe(true);
  return result;
}

async function playerDiamondBalance(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<number> {
  const rows = await readServiceRows<{ diamonds: number; diamond_balance: number }>(
    environment,
    'profiles',
    query('diamonds,diamond_balance', { id: `eq.${userId}` })
  );
  expect(rows).toHaveLength(1);
  expect(numeric(rows[0].diamond_balance)).toBe(numeric(rows[0].diamonds));
  return numeric(rows[0].diamonds);
}

async function canonicalDailyContract(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount
): Promise<DailyChallengeContract> {
  const dashboard = await authenticatedDashboard(account);
  const assignedDate = dashboard.periodKeys.daily;
  expect(assignedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const rows = await readServiceRows<CanonicalDailyChallengeRow>(
    environment,
    'user_daily_challenges',
    query(
      'id,challenge_id,challenge_type_snapshot,requirement_snapshot,diamond_reward_snapshot,progress,completed,claimed,assigned_date',
      {
        user_id: `eq.${account.id}`,
        assigned_date: `eq.${assignedDate}`,
        tier_snapshot: 'eq.daily',
        order: 'diamond_reward_snapshot.asc,challenge_id.asc',
      }
    )
  );
  expect(rows).toHaveLength(5);
  const pendingOutbox = await readServiceRows<{ event_key: string }>(
    environment,
    'daily_challenge_event_outbox',
    query('event_key', { user_id: `eq.${account.id}` })
  );
  expect(pendingOutbox).toEqual([]);
  for (const row of rows) {
    expect(
      row.claimed,
      `Canonical Mission ${row.id} Must Not Already Be Claimed By A Fresh Certification Account.`
    ).toBe(false);
    if (numeric(row.progress) > 0 || row.completed) {
      expect(
        row.challenge_type_snapshot,
        `Only The Known Signup Friendship Event May Progress Mission ${row.id}.`
      ).toBe('friends_added');
    }
  }

  // Signup's two real auto-connect friendship events may progress or complete
  // a canonical friendship mission. Neutralize only those known pre-test facts
  // after proving none is settled, so the seven-day accounting starts at zero.
  const normalizedRows = await updateServiceRows<CanonicalDailyChallengeRow>(
    environment,
    'user_daily_challenges',
    query(
      'id,challenge_id,challenge_type_snapshot,requirement_snapshot,diamond_reward_snapshot,progress,completed,claimed,assigned_date',
      {
        user_id: `eq.${account.id}`,
        assigned_date: `eq.${assignedDate}`,
        tier_snapshot: 'eq.daily',
        claimed: 'eq.false',
      }
    ),
    { progress: 0, completed: false, completed_at: null }
  );
  expect(normalizedRows).toHaveLength(5);
  for (const row of normalizedRows) {
    expect(row).toMatchObject({
      assigned_date: assignedDate,
      progress: 0,
      completed: false,
      claimed: false,
    });
  }

  const row = [...normalizedRows].sort(
    (left, right) =>
      numeric(left.diamond_reward_snapshot) - numeric(right.diamond_reward_snapshot) ||
      left.challenge_id.localeCompare(right.challenge_id)
  )[0];
  expect(numeric(row.requirement_snapshot)).toBeGreaterThan(0);
  expect(numeric(row.diamond_reward_snapshot)).toBeGreaterThan(0);
  return {
    assignmentId: row.id,
    assignedDate,
    id: row.challenge_id,
    requirement: numeric(row.requirement_snapshot),
    diamond_reward: numeric(row.diamond_reward_snapshot),
  };
}

async function completeCanonicalDailyAssignment(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount,
  challenge: DailyChallengeContract
): Promise<DailyChallengeRow> {
  const rows = await updateServiceRows<DailyChallengeRow>(
    environment,
    'user_daily_challenges',
    query('id,assigned_date,progress,completed,claimed,diamond_reward_snapshot', {
      id: `eq.${challenge.assignmentId}`,
      user_id: `eq.${account.id}`,
      progress: 'eq.0',
      completed: 'eq.false',
      claimed: 'eq.false',
    }),
    {
      progress: challenge.requirement,
      completed: true,
      completed_at: new Date().toISOString(),
    }
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    assigned_date: challenge.assignedDate,
    progress: challenge.requirement,
    completed: true,
    claimed: false,
    diamond_reward_snapshot: challenge.diamond_reward,
  });
  return rows[0];
}

async function catalogContractStillMatches(
  environment: CustomizationCertificationEnvironment,
  challenge: DailyChallengeContract
): Promise<void> {
  const rows = await readServiceRows<{ requirement: number; diamond_reward: number }>(
    environment,
    'daily_challenge_catalog',
    query('requirement,diamond_reward', {
      id: `eq.${challenge.id}`,
      is_active: 'eq.true',
      limit: '1',
    })
  );
  expect(rows).toHaveLength(1);
  expect(numeric(rows[0].requirement)).toBe(challenge.requirement);
  expect(numeric(rows[0].diamond_reward)).toBe(challenge.diamond_reward);
}

async function sevenDayMilestone(
  environment: CustomizationCertificationEnvironment
): Promise<DailyChallengeMilestone> {
  const rows = await readServiceRows<DailyChallengeMilestone>(
    environment,
    'daily_challenge_milestones',
    query('days,reward_diamonds', { days: 'eq.7' })
  );
  expect(rows).toHaveLength(1);
  expect(numeric(rows[0].reward_diamonds)).toBeGreaterThan(0);
  expect(Number.isSafeInteger(numeric(rows[0].reward_diamonds))).toBe(true);
  return rows[0];
}

async function seedCompletedDailyRun(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount,
  challenge: DailyChallengeContract,
  assignedDates: string[]
): Promise<DailyChallengeRow[]> {
  const timestamp = new Date().toISOString();
  return insertServiceRows<DailyChallengeRow>(
    environment,
    'user_daily_challenges',
    assignedDates.map((assignedDate) => ({
      user_id: account.id,
      challenge_id: challenge.id,
      assigned_date: assignedDate,
      progress: numeric(challenge.requirement),
      completed: true,
      completed_at: timestamp,
      claimed: false,
    }))
  );
}

async function dashboardRevision(
  environment: CustomizationCertificationEnvironment,
  userId: string
): Promise<number> {
  const rows = await readServiceRows<{ revision: number }>(
    environment,
    'daily_challenge_dashboard_revisions',
    query('revision', { user_id: `eq.${userId}` })
  );
  expect(rows).toHaveLength(1);
  return numeric(rows[0].revision);
}

async function installHistoricalBoostedMilestone(
  environment: CustomizationCertificationEnvironment,
  account: TemporaryCustomizationAccount,
  currentBalance: number,
  streakStartedOn: string
): Promise<void> {
  const boostedBalance = currentBalance + HISTORICAL_MILESTONE_ACTUAL_DIAMONDS;
  const historicalRunId = randomUUID();
  // 2026-09-07 (Diamond Accounting Standard DR2, DR6): the 15 historical diamonds reach the balance
  // through the Mint, which registers and journals the movement, never through a direct write to
  // profiles.diamonds. A direct write moved the balance with no register row and filed DR6 on every
  // run of this spec. The multiplier is a profile attribute, not money, and is still set directly.
  const minted = await callServiceRpc<{ ok?: boolean; replayed?: boolean; reason?: string }>(
    environment,
    'fn_ca_mint',
    {
      p_asset: 'diamonds',
      p_destination: 'player',
      p_target_id: account.id,
      p_amount: HISTORICAL_MILESTONE_ACTUAL_DIAMONDS,
      p_reason: 'Daily Missions certification: historical boosted milestone fixture',
      p_op_id: `daily-missions-historical-fixture:${historicalRunId}`,
      p_class: 'earned',
    }
  );
  expect(minted.ok === true || minted.replayed === true, String(minted.reason || '')).toBe(true);
  const profile = await updateServiceRows<{
    diamonds: number;
    diamond_balance: number;
    diamond_multiplier: number;
  }>(
    environment,
    'profiles',
    query('diamonds,diamond_balance,diamond_multiplier', { id: `eq.${account.id}` }),
    { diamond_multiplier: 1.5 }
  );
  expect(profile).toHaveLength(1);
  expect(numeric(profile[0].diamonds)).toBe(boostedBalance);
  expect(numeric(profile[0].diamond_balance)).toBe(boostedBalance);
  expect(numeric(profile[0].diamond_multiplier)).toBe(1.5);

  await insertServiceRows(environment, 'daily_challenge_milestone_claims', {
    user_id: account.id,
    streak_run_id: historicalRunId,
    streak_started_on: streakStartedOn,
    milestone_days: 777,
    reward_diamonds: HISTORICAL_MILESTONE_RAW_DIAMONDS,
  });
  // The register follows the journal (trg_ca_diamond_register_follows_journal): a journal row
  // whose source is not 'the_mint' is registered as a second issuance. The 15 above were issued
  // and registered by fn_ca_mint under the op id in metadata, so this row, which exists only so
  // the dashboard sees a historical multiplier-shaped milestone, names the Mint as its source and
  // registers nothing. One movement, one register row, one balance change.
  await insertServiceRows(environment, 'diamond_transactions', {
    user_id: account.id,
    amount: HISTORICAL_MILESTONE_ACTUAL_DIAMONDS,
    transaction_type: 'daily_mission_milestone',
    type: 'daily_mission_milestone',
    source: 'the_mint',
    description: 'Historical Daily Missions Streak Circuit [1.5x Boost]',
    balance_after: boostedBalance,
    reference_id: `daily-missions-historical-multiplier:${historicalRunId}`,
    metadata: {
      reference_id: `daily-missions-historical-multiplier:${historicalRunId}`,
      raw_amount: HISTORICAL_MILESTONE_RAW_DIAMONDS,
      multiplier: 1.5,
      exact_value: false,
      certification: 'historical_multiplier_compatibility',
      registered_by_op_id: `daily-missions-historical-fixture:${historicalRunId}`,
    },
    counterparty: 'promo_budget:daily_mission_milestone',
    issuance_class: 'earned',
  });
}

async function authenticatedClaim(
  account: TemporaryCustomizationAccount,
  challengeRowId: string,
  requestId: string
): Promise<ClaimReceipt> {
  const { data, error } = await account.client.rpc('claim_daily_challenges', {
    p_user_id: account.id,
    p_challenge_row_ids: [challengeRowId],
    p_request_id: requestId,
  });
  if (error) throw error;
  return data as ClaimReceipt;
}

async function authenticatedStreak(account: TemporaryCustomizationAccount): Promise<StreakReceipt> {
  const { data, error } = await account.client.rpc('get_challenge_streak', {
    p_user_id: account.id,
  });
  if (error) throw error;
  return data as StreakReceipt;
}

async function authenticatedDashboard(
  account: TemporaryCustomizationAccount
): Promise<DashboardReceipt> {
  const { data, error } = await account.client.rpc('get_daily_challenge_dashboard_v3');
  if (error) throw error;
  return data as DashboardReceipt;
}

function expectImmutableSettlement(
  replay: ClaimReceipt,
  settlement: ClaimReceipt,
  currentDiamondBalance: number
): void {
  expect(replay).toMatchObject({
    success: true,
    replayed: true,
    claimedIds: settlement.claimedIds,
    alreadyClaimedIds: settlement.alreadyClaimedIds,
    diamonds: settlement.diamonds,
    challengeDiamonds: settlement.challengeDiamonds,
    milestoneDiamonds: settlement.milestoneDiamonds,
    diamondsCredited: settlement.diamondsCredited,
    settlementDiamondBalance: settlement.settlementDiamondBalance,
    settlementVersion: 2,
    diamondBalance: currentDiamondBalance,
  });
}

test.describe('Daily Missions Database Settlement Certification', () => {
  test.skip(
    !CERTIFICATION_ENABLED,
    'Set DAILY_MISSIONS_CERTIFICATION=1 To Create Isolated Database Settlement Fixtures.'
  );
  test.describe.configure({ mode: 'serial', timeout: 720_000 });

  test('Day Seven Claim Pays Its Mission And Milestone Exactly Once Across Replays', async () => {
    const environment = requireCustomizationCertificationEnvironment();
    let account: TemporaryCustomizationAccount | null = null;

    try {
      account = await createTemporaryCustomizationAccount(environment, 'settlement', 100);
      const fundedOpeningBalance = await playerDiamondBalance(environment, account.id);
      const challenge = await canonicalDailyContract(environment, account);
      const today = challenge.assignedDate;
      const utcOrigin = new Date(`${today}T12:00:00.000Z`);
      await catalogContractStillMatches(environment, challenge);
      const milestone = await sevenDayMilestone(environment);
      const completedDates = Array.from({ length: 7 }, (_, index) =>
        utcDateOffset(index - 6, utcOrigin)
      );

      // Old milestone rows could be multiplier-boosted before this release.
      // Preserve one honest historical fixture: the immutable claim says 10,
      // while the append-only wallet journal proves that 15 actually moved.
      await installHistoricalBoostedMilestone(
        environment,
        account,
        fundedOpeningBalance,
        utcDateOffset(-100, utcOrigin)
      );
      const openingMissionBalance = await playerDiamondBalance(environment, account.id);
      expect(openingMissionBalance).toBe(
        fundedOpeningBalance + HISTORICAL_MILESTONE_ACTUAL_DIAMONDS
      );

      const challengeDiamonds = numeric(challenge.diamond_reward);
      const milestoneDiamonds = numeric(milestone.reward_diamonds);
      const assignments: DailyChallengeRow[] = [];
      for (const [index, assignedDate] of completedDates.slice(0, -1).entries()) {
        const [assignment] = await seedCompletedDailyRun(environment, account, challenge, [
          assignedDate,
        ]);
        assignments.push(assignment);
        const priorSettlement = await authenticatedClaim(account, assignment.id, randomUUID());
        expect(priorSettlement).toMatchObject({
          success: true,
          replayed: false,
          claimedIds: [assignment.id],
          challengeDiamonds,
          milestoneDiamonds: 0,
          diamondsCredited: challengeDiamonds,
          stats: {
            totalClaimed: index + 1,
            totalDiamondsEarned:
              HISTORICAL_MILESTONE_ACTUAL_DIAMONDS + challengeDiamonds * (index + 1),
          },
        });
      }

      const target = await completeCanonicalDailyAssignment(environment, account, challenge);
      assignments.push(target);
      expect(assignments).toHaveLength(7);
      expect(target).toMatchObject({ completed: true, claimed: false });
      expect(numeric(target.diamond_reward_snapshot)).toBe(challengeDiamonds);

      const milestoneBefore = await readServiceRows<DailyChallengeMilestoneClaim>(
        environment,
        'daily_challenge_milestone_claims',
        query('*', { user_id: `eq.${account.id}` })
      );
      expect(milestoneBefore).toHaveLength(1);
      expect(milestoneBefore[0]).toMatchObject({
        user_id: account.id,
        milestone_days: 777,
      });
      expect(numeric(milestoneBefore[0].reward_diamonds)).toBe(HISTORICAL_MILESTONE_RAW_DIAMONDS);

      const dashboardBeforeDaySeven = await authenticatedDashboard(account);
      expect(dashboardBeforeDaySeven).toMatchObject({
        diamondBalance: openingMissionBalance + challengeDiamonds * 6,
        stats: {
          totalClaimed: 6,
          totalDiamondsEarned: HISTORICAL_MILESTONE_ACTUAL_DIAMONDS + challengeDiamonds * 6,
        },
      });

      const requestId = randomUUID();
      const settlement = await authenticatedClaim(account, target.id, requestId);
      const diamondsCredited = challengeDiamonds + milestoneDiamonds;
      const balanceBeforeDaySeven = openingMissionBalance + challengeDiamonds * 6;
      const settlementBalance = balanceBeforeDaySeven + diamondsCredited;
      const lifetimeDailyMissionDiamonds =
        HISTORICAL_MILESTONE_ACTUAL_DIAMONDS + challengeDiamonds * 7 + milestoneDiamonds;

      expect(settlement).toMatchObject({
        success: true,
        replayed: false,
        claimedIds: [target.id],
        alreadyClaimedIds: [],
        diamonds: challengeDiamonds,
        challengeDiamonds,
        milestoneDiamonds,
        diamondsCredited,
        diamondBalance: settlementBalance,
        settlementDiamondBalance: settlementBalance,
        settlementVersion: 2,
        stats: {
          totalClaimed: 7,
          totalDiamondsEarned: lifetimeDailyMissionDiamonds,
        },
      });
      expect(await playerDiamondBalance(environment, account.id)).toBe(settlementBalance);

      const dashboardAfterSettlement = await authenticatedDashboard(account);
      expect(dashboardAfterSettlement).toMatchObject({
        diamondBalance: settlementBalance,
        stats: {
          totalClaimed: 7,
          totalDiamondsEarned: lifetimeDailyMissionDiamonds,
        },
      });

      const claimBatches = await readServiceRows<DailyChallengeClaimBatch>(
        environment,
        'daily_challenge_claim_batches',
        query('user_id,request_id,challenge_row_ids,result,created_at', {
          user_id: `eq.${account.id}`,
          request_id: `eq.${requestId}`,
        })
      );
      expect(claimBatches).toHaveLength(1);
      expect(claimBatches[0].request_id).toBe(requestId);
      expect(claimBatches[0].challenge_row_ids).toEqual([target.id]);
      expect(claimBatches[0].result).toEqual(settlement);

      const firstReplay = await authenticatedClaim(account, target.id, requestId);
      expectImmutableSettlement(firstReplay, settlement, settlementBalance);
      expect(await playerDiamondBalance(environment, account.id)).toBe(settlementBalance);

      const milestoneClaims = await readServiceRows<DailyChallengeMilestoneClaim>(
        environment,
        'daily_challenge_milestone_claims',
        query('user_id,streak_run_id,streak_started_on,milestone_days,reward_diamonds,claimed_at', {
          user_id: `eq.${account.id}`,
          order: 'claimed_at.asc,milestone_days.asc',
        })
      );
      expect(milestoneClaims).toHaveLength(2);
      const currentMilestoneClaim = milestoneClaims.find((claim) => claim.milestone_days === 7);
      expect(currentMilestoneClaim).toBeTruthy();
      expect(currentMilestoneClaim).toMatchObject({
        user_id: account.id,
        streak_started_on: completedDates[0],
        milestone_days: 7,
      });
      expect(numeric(currentMilestoneClaim?.reward_diamonds)).toBe(milestoneDiamonds);
      expect(currentMilestoneClaim?.streak_run_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      const claimReference = `challenge_claim_batch:${requestId}:diamonds`;
      const claimTransactions = await readServiceRows<DiamondTransaction>(
        environment,
        'diamond_transactions',
        query('amount,transaction_type,type,balance_after,reference_id,metadata,created_at', {
          user_id: `eq.${account.id}`,
          transaction_type: 'eq.daily_challenge_claim',
          order: 'created_at.asc,reference_id.asc',
        })
      );
      expect(claimTransactions).toHaveLength(7);
      const finalClaimTransaction = claimTransactions.find(
        (transaction) => transaction.reference_id === claimReference
      );
      expect(finalClaimTransaction).toBeTruthy();
      expect(finalClaimTransaction).toMatchObject({
        transaction_type: 'daily_challenge_claim',
        type: 'daily_challenge_claim',
        reference_id: claimReference,
      });
      expect(numeric(finalClaimTransaction?.amount)).toBe(challengeDiamonds);
      expect(numeric(finalClaimTransaction?.balance_after)).toBe(settlementBalance);
      expect(finalClaimTransaction?.metadata).toMatchObject({
        request_id: requestId,
        challenge_row_ids: [target.id],
        assigned_diamond_reward: challengeDiamonds,
      });

      const milestoneReference =
        `daily_mission_milestones:${account.id}:` + `${currentMilestoneClaim?.streak_run_id}:7`;
      const milestoneTransactions = await readServiceRows<DiamondTransaction>(
        environment,
        'diamond_transactions',
        query('amount,transaction_type,type,balance_after,reference_id,metadata,created_at', {
          user_id: `eq.${account.id}`,
          transaction_type: 'eq.daily_mission_milestone',
          order: 'created_at.asc,reference_id.asc',
        })
      );
      expect(milestoneTransactions).toHaveLength(2);
      const currentMilestoneTransaction = milestoneTransactions.find(
        (transaction) => transaction.reference_id === milestoneReference
      );
      expect(currentMilestoneTransaction).toBeTruthy();
      expect(currentMilestoneTransaction).toMatchObject({
        transaction_type: 'daily_mission_milestone',
        type: 'daily_mission_milestone',
        reference_id: milestoneReference,
      });
      expect(numeric(currentMilestoneTransaction?.amount)).toBe(milestoneDiamonds);
      expect(numeric(currentMilestoneTransaction?.balance_after)).toBe(
        balanceBeforeDaySeven + milestoneDiamonds
      );
      expect(currentMilestoneTransaction?.metadata).toMatchObject({
        raw_amount: milestoneDiamonds,
        multiplier: 1,
        exact_value: true,
      });
      const historicalMilestoneTransaction = milestoneTransactions.find(
        (transaction) => transaction.reference_id !== milestoneReference
      );
      expect(numeric(historicalMilestoneTransaction?.amount)).toBe(
        HISTORICAL_MILESTONE_ACTUAL_DIAMONDS
      );
      expect(historicalMilestoneTransaction?.metadata).toMatchObject({
        raw_amount: HISTORICAL_MILESTONE_RAW_DIAMONDS,
        multiplier: 1.5,
        exact_value: false,
      });

      const mutationReference = `daily-missions-response-loss:${requestId}`;
      const mutation = await callServiceRpc<JsonObject>(environment, 'add_diamonds_to_balance', {
        p_user_id: account.id,
        p_amount: RESPONSE_LOSS_MUTATION_DIAMONDS,
        p_type: 'adjustment',
        p_description: 'Daily Missions Response Loss Settlement Probe',
        p_reference_id: mutationReference,
      });
      expect(mutation).toMatchObject({
        success: true,
        old_balance: settlementBalance,
        new_balance: settlementBalance + RESPONSE_LOSS_MUTATION_DIAMONDS,
        amount: RESPONSE_LOSS_MUTATION_DIAMONDS,
      });
      const currentBalance = settlementBalance + RESPONSE_LOSS_MUTATION_DIAMONDS;

      const delayedReplay = await authenticatedClaim(account, target.id, requestId);
      expectImmutableSettlement(delayedReplay, settlement, currentBalance);
      expect(await playerDiamondBalance(environment, account.id)).toBe(currentBalance);
      const dashboardAfterUnrelatedWalletMutation = await authenticatedDashboard(account);
      expect(dashboardAfterUnrelatedWalletMutation).toMatchObject({
        diamondBalance: currentBalance,
        stats: {
          totalClaimed: 7,
          totalDiamondsEarned: lifetimeDailyMissionDiamonds,
        },
      });

      const persistedAfterDelayedReplay = await readServiceRows<DailyChallengeClaimBatch>(
        environment,
        'daily_challenge_claim_batches',
        query('user_id,request_id,challenge_row_ids,result,created_at', {
          user_id: `eq.${account.id}`,
          request_id: `eq.${requestId}`,
        })
      );
      expect(persistedAfterDelayedReplay).toEqual(claimBatches);

      const exactMilestoneRowsAfterReplay = await readServiceRows<DailyChallengeMilestoneClaim>(
        environment,
        'daily_challenge_milestone_claims',
        query('user_id,streak_run_id,streak_started_on,milestone_days,reward_diamonds,claimed_at', {
          user_id: `eq.${account.id}`,
          order: 'claimed_at.asc,milestone_days.asc',
        })
      );
      expect(exactMilestoneRowsAfterReplay).toEqual(milestoneClaims);

      const exactClaimTransactionsAfterReplay = await readServiceRows<DiamondTransaction>(
        environment,
        'diamond_transactions',
        query('amount,transaction_type,type,balance_after,reference_id,metadata,created_at', {
          user_id: `eq.${account.id}`,
          transaction_type: 'eq.daily_challenge_claim',
          order: 'created_at.asc,reference_id.asc',
        })
      );
      expect(exactClaimTransactionsAfterReplay).toEqual(claimTransactions);
      const exactMilestoneTransactionsAfterReplay = await readServiceRows<DiamondTransaction>(
        environment,
        'diamond_transactions',
        query('amount,transaction_type,type,balance_after,reference_id,metadata,created_at', {
          user_id: `eq.${account.id}`,
          transaction_type: 'eq.daily_mission_milestone',
          order: 'created_at.asc,reference_id.asc',
        })
      );
      expect(exactMilestoneTransactionsAfterReplay).toEqual(milestoneTransactions);

      const mutationTransactions = await readServiceRows<DiamondTransaction>(
        environment,
        'diamond_transactions',
        query('amount,transaction_type,type,balance_after,reference_id,metadata,created_at', {
          user_id: `eq.${account.id}`,
          reference_id: `eq.${mutationReference}`,
        })
      );
      expect(mutationTransactions).toHaveLength(1);
      expect(mutationTransactions[0]).toMatchObject({
        transaction_type: 'adjustment',
        type: 'adjustment',
        reference_id: mutationReference,
      });
      expect(numeric(mutationTransactions[0].amount)).toBe(RESPONSE_LOSS_MUTATION_DIAMONDS);
      expect(numeric(mutationTransactions[0].balance_after)).toBe(currentBalance);
    } finally {
      if (account) await cleanupTemporaryCustomizationAccount(environment, account);
    }
  });

  test('One Missed Day Consumes One Freeze And Keeps A Persistent Reload Receipt', async () => {
    const environment = requireCustomizationCertificationEnvironment();
    let account: TemporaryCustomizationAccount | null = null;

    try {
      account = await createTemporaryCustomizationAccount(environment, 'freeze', 0);
      const challenge = await canonicalDailyContract(environment, account);
      const today = challenge.assignedDate;
      const utcOrigin = new Date(`${today}T12:00:00.000Z`);
      await catalogContractStillMatches(environment, challenge);
      const missedDate = utcDateOffset(-1, utcOrigin);
      const oldestCompletedDate = utcDateOffset(-4, utcOrigin);
      const completedDates = [
        today,
        utcDateOffset(-2, utcOrigin),
        utcDateOffset(-3, utcOrigin),
        oldestCompletedDate,
      ];
      const historicalAssignments = await seedCompletedDailyRun(
        environment,
        account,
        challenge,
        completedDates.filter((assignedDate) => assignedDate !== today)
      );
      const assignments = [
        ...historicalAssignments,
        await completeCanonicalDailyAssignment(environment, account, challenge),
      ];
      expect(assignments).toHaveLength(4);

      await deleteServiceRows(
        environment,
        'challenge_streak_state',
        new URLSearchParams({ user_id: `eq.${account.id}` })
      );
      await insertServiceRows(environment, 'challenge_streak_state', {
        user_id: account.id,
        freezes_available: 1,
        freezes_used: 0,
        freezes_earned: 0,
        frozen_dates: [],
      });

      const firstCalculation = await authenticatedStreak(account);
      expect(firstCalculation).toMatchObject({
        streak: 5,
        streakStartedOn: oldestCompletedDate,
        streakEndedOn: today,
        freezesAvailable: 0,
        usedFreeze: true,
        frozenDate: missedDate,
        lastFrozenDate: missedDate,
        honoredFrozenDates: 1,
        consumedFreeze: true,
        consumedFrozenDate: missedDate,
        freezeReceiptVersion: 2,
      });
      expect(firstCalculation.streakRunId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );

      const stateAfterConsumption = await readServiceRows<ChallengeStreakState>(
        environment,
        'challenge_streak_state',
        query(
          'freezes_available,freezes_used,freezes_earned,frozen_dates,current_streak_run_id,current_streak_started_on,current_streak_ended_on,current_streak_length,updated_at',
          { user_id: `eq.${account.id}` }
        )
      );
      expect(stateAfterConsumption).toHaveLength(1);
      expect(stateAfterConsumption[0]).toMatchObject({
        freezes_available: 0,
        freezes_used: 1,
        freezes_earned: 0,
        frozen_dates: [missedDate],
        current_streak_run_id: firstCalculation.streakRunId,
        current_streak_started_on: oldestCompletedDate,
        current_streak_ended_on: today,
        current_streak_length: 5,
      });

      const reloadReceipt = await authenticatedStreak(account);
      expect(reloadReceipt).toMatchObject({
        streak: 5,
        streakRunId: firstCalculation.streakRunId,
        streakStartedOn: oldestCompletedDate,
        streakEndedOn: today,
        freezesAvailable: 0,
        usedFreeze: true,
        frozenDate: missedDate,
        lastFrozenDate: missedDate,
        honoredFrozenDates: 1,
        consumedFreeze: false,
        consumedFrozenDate: null,
        freezeReceiptVersion: 2,
      });

      const replayReceipt = await authenticatedStreak(account);
      expect(replayReceipt).toEqual(reloadReceipt);

      // Simulate two open tabs repeatedly refreshing the same authoritative
      // dashboard. Warm assignment first, then prove timestamp-only streak
      // recalculation cannot make the tabs bump and reload one another.
      const secondTabClient = createClient(environment.supabaseUrl, environment.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { error: secondTabSignInError } = await secondTabClient.auth.signInWithPassword({
        email: account.email,
        password: account.password,
      });
      if (secondTabSignInError) throw secondTabSignInError;

      await authenticatedDashboard(account);
      const { error: secondTabWarmError } = await secondTabClient.rpc(
        'get_daily_challenge_dashboard_v3'
      );
      if (secondTabWarmError) throw secondTabWarmError;
      const settledRevision = await dashboardRevision(environment, account.id);

      for (let pass = 0; pass < 3; pass += 1) {
        const [firstTab, secondTab] = await Promise.all([
          account.client.rpc('get_daily_challenge_dashboard_v3'),
          secondTabClient.rpc('get_daily_challenge_dashboard_v3'),
        ]);
        if (firstTab.error) throw firstTab.error;
        if (secondTab.error) throw secondTab.error;
      }
      expect(await dashboardRevision(environment, account.id)).toBe(settledRevision);
      await secondTabClient.auth.signOut();

      const finalState = await readServiceRows<ChallengeStreakState>(
        environment,
        'challenge_streak_state',
        query(
          'freezes_available,freezes_used,freezes_earned,frozen_dates,current_streak_run_id,current_streak_started_on,current_streak_ended_on,current_streak_length,updated_at',
          { user_id: `eq.${account.id}` }
        )
      );
      expect(finalState).toHaveLength(1);
      expect(finalState[0]).toEqual(stateAfterConsumption[0]);
      expect(finalState[0].updated_at).toBe(stateAfterConsumption[0].updated_at);
      expect(finalState[0].frozen_dates).toEqual([missedDate]);
      expect(finalState[0].frozen_dates.filter((date) => date === missedDate)).toHaveLength(1);
    } finally {
      if (account) await cleanupTemporaryCustomizationAccount(environment, account);
    }
  });
});
