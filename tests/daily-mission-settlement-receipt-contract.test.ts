import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const claimMigration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260907043114_daily_mission_claim_receipts_account_for_every_diamond.sql'
  ),
  'utf8'
);

const freezeMigration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260907043126_daily_mission_freeze_history_survives_reload.sql'
  ),
  'utf8'
);

function section(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `missing section end: ${end}`).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe('Daily Missions complete Diamond settlement migration', () => {
  it('is one forward-only transaction with an in-transaction certification gate', () => {
    expect(claimMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(claimMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(claimMigration.indexOf('DO $verify$')).toBeGreaterThan(
      claimMigration.indexOf('CREATE OR REPLACE FUNCTION public.claim_daily_challenges')
    );
    expect(claimMigration.indexOf('COMMIT;')).toBeGreaterThan(
      claimMigration.indexOf('DO $verify$')
    );
    expect(claimMigration).toContain("SET LOCAL lock_timeout = '4s'");
  });

  it('preserves legacy receipts instead of guessing their milestone attribution', () => {
    expect(claimMigration).toContain('only fresh settlements written below become v2');
    expect(claimMigration).not.toContain('milestone.claimed_at = batch.created_at');
    expect(claimMigration).not.toContain('UPDATE public.daily_challenge_claim_batches batch');
    expect(claimMigration).toContain("(v_stored_result ->> 'settlementVersion') = '2'");
    expect(claimMigration).toContain('RETURN v_stored_result || jsonb_build_object(');
  });

  it('retires the non-idempotent one-card entry point and removes every execution grant', () => {
    const single = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.claim_daily_challenge(',
      'REVOKE ALL ON FUNCTION public.claim_daily_challenge(uuid, uuid, numeric)'
    );

    expect(single).toContain('SECURITY INVOKER');
    expect(single).toContain('Legacy claim RPC retired; use claim_daily_challenges');
    expect(single).not.toContain('claim_daily_challenge_serialized_body');
    expect(claimMigration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(claimMigration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_daily_challenge\(uuid, uuid, numeric\)/
    );
  });

  it('persists an exact settlement and refreshes only the wallet projection on replay', () => {
    const batch = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.claim_daily_challenges(',
      'REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)'
    );
    const receiptLookup = batch.indexOf('SELECT challenge_row_ids, result');
    const replayReturn = batch.indexOf('RETURN v_stored_result || jsonb_build_object(');
    const settlement = batch.indexOf('claim_daily_challenges_serialized_body');
    const finalBalance = batch.indexOf('FROM public.profiles', settlement);
    const challengeLifetime = batch.indexOf('INTO v_total_challenge_diamonds', settlement);
    const persist = batch.indexOf('result = v_result', finalBalance);
    const verifyStored = batch.indexOf('v_stored_result IS DISTINCT FROM v_result', persist);

    expect(receiptLookup).toBeGreaterThanOrEqual(0);
    expect(replayReturn).toBeGreaterThan(receiptLookup);
    expect(settlement).toBeGreaterThan(replayReturn);
    expect(finalBalance).toBeGreaterThan(settlement);
    expect(challengeLifetime).toBeGreaterThan(finalBalance);
    expect(persist).toBeGreaterThan(finalBalance);
    expect(verifyStored).toBeGreaterThan(persist);
    expect(batch).toContain('v_bound_ids IS DISTINCT FROM v_requested_ids');
    expect(batch).toContain("'challengeDiamonds', v_challenge_diamonds");
    expect(batch).toContain("'milestoneDiamonds', v_milestone_diamonds");
    expect(batch).toContain("'diamondsCredited', v_diamonds_credited");
    expect(batch).toContain("'diamondBalance', v_diamond_balance");
    expect(batch).toContain("'settlementDiamondBalance', v_diamond_balance");
    expect(batch).toContain("'replayed', true");
    expect(batch).toContain("(v_stored_result ->> 'settlementDiamondBalance')::numeric");
  });

  it('constrains milestone configuration and receipts to exact whole Diamonds', () => {
    const catalogLock = claimMigration.indexOf(
      'LOCK TABLE public.daily_challenge_milestones\n  IN ACCESS EXCLUSIVE MODE;'
    );
    const claimsLock = claimMigration.indexOf(
      'LOCK TABLE public.daily_challenge_milestone_claims\n  IN ACCESS EXCLUSIVE MODE;'
    );
    expect(catalogLock).toBeGreaterThanOrEqual(0);
    expect(claimsLock).toBeGreaterThan(catalogLock);
    expect(claimMigration).toContain('reward_diamonds <> trunc(reward_diamonds)');
    expect(claimMigration).toContain('reward_diamonds > 2147483647');
    expect(claimMigration).toContain(
      'ADD CONSTRAINT daily_challenge_milestones_reward_diamonds_whole'
    );
    expect(claimMigration).toContain(
      'ADD CONSTRAINT daily_challenge_milestone_claims_reward_diamonds_whole'
    );
    expect(claimMigration).toContain('AND convalidated');
  });

  it('includes milestone payouts in both fresh receipts and the dashboard lifetime total', () => {
    const batch = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.claim_daily_challenges(',
      'REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid)'
    );
    const dashboard = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.get_daily_challenge_dashboard_v3()',
      'REVOKE ALL ON FUNCTION public.get_daily_challenge_dashboard_v3()'
    );
    expect(claimMigration).toContain("'{stats,totalDiamondsEarned}'");
    expect(claimMigration).toContain('v_total_challenge_diamonds + v_milestones_after');
    expect(batch).toContain('FROM public.diamond_transactions');
    expect(batch).toContain("transaction_type = 'daily_mission_milestone'");
    expect(dashboard).toContain('v_total_challenge_diamonds + v_total_milestone_diamonds');
    expect(dashboard).toContain("v_dashboard #>> '{stats,totalDiamondsEarned}'");
    expect(dashboard).not.toContain('FROM public.user_daily_challenges');
    expect(dashboard).toContain('FROM public.diamond_transactions');
    expect(dashboard).toContain("transaction_type = 'daily_mission_milestone'");
  });

  it('keeps milestone credits exact and checks amount, aggregate, and wallet headroom', () => {
    const credit = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.add_diamonds_to_balance(',
      'REVOKE ALL ON FUNCTION public.add_diamonds_to_balance(uuid, integer, text, text, text)'
    );
    const awarder = section(
      claimMigration,
      'CREATE OR REPLACE FUNCTION public.fn_award_daily_mission_milestones(',
      'REVOKE ALL ON FUNCTION public.fn_award_daily_mission_milestones(uuid)'
    );

    expect(credit).toContain("'daily_mission_milestone'");
    expect(credit).toContain('v_old_balance bigint');
    expect(credit).toContain('v_actual_amount bigint');
    expect(credit).toContain("'diamond_amount_out_of_range'");
    expect(credit).toContain("'diamond_balance_limit'");
    expect(awarder).toContain('v_reward <> trunc(v_reward)');
    expect(awarder).toContain('v_reward > 2147483647');
  });
});

describe('Daily Missions persistent freeze receipt migration', () => {
  it('keeps the proven calculator private behind a compatibility wrapper', () => {
    expect(freezeMigration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(freezeMigration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(freezeMigration).toContain("SET LOCAL lock_timeout = '4s'");
    expect(freezeMigration).toContain('RENAME TO get_challenge_streak_calculate_body');
    expect(freezeMigration).toContain(
      'REVOKE ALL ON FUNCTION public.get_challenge_streak_calculate_body(uuid)'
    );
    expect(freezeMigration).toContain('FROM PUBLIC, anon, authenticated, service_role');
    expect(freezeMigration).toContain(
      'v_result := public.get_challenge_streak_calculate_body(p_user_id)'
    );
  });

  it('skips the current-run state write when a warm calculation is unchanged', () => {
    const calculator = section(
      freezeMigration,
      'CREATE OR REPLACE FUNCTION public.get_challenge_streak_calculate_body(',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak_calculate_body(uuid)'
    );
    const stateGuard = calculator.indexOf('IF ROW(');
    const currentRunWrite = calculator.indexOf('UPDATE public.challenge_streak_state', stateGuard);
    const stateReturn = calculator.indexOf('RETURNING * INTO v_state;', currentRunWrite);
    const guardEnd = calculator.indexOf('END IF;', stateGuard);

    expect(stateGuard).toBeGreaterThanOrEqual(0);
    expect(currentRunWrite).toBeGreaterThan(stateGuard);
    expect(stateReturn).toBeGreaterThan(currentRunWrite);
    expect(guardEnd).toBeGreaterThan(stateReturn);
    expect(calculator).toContain('v_state.current_streak_run_id');
    expect(calculator).toContain('v_state.current_streak_started_on');
    expect(calculator).toContain('v_state.current_streak_ended_on');
    expect(calculator).toContain('v_state.current_streak_length');
    expect(calculator).toContain('IS DISTINCT FROM ROW(');
    expect(calculator.slice(stateGuard, currentRunWrite)).not.toContain('updated_at');
  });

  it('separates persistent active-run history from one-call inventory consumption', () => {
    const streak = section(
      freezeMigration,
      'CREATE FUNCTION public.get_challenge_streak(',
      'REVOKE ALL ON FUNCTION public.get_challenge_streak(uuid)'
    );
    const captureConsumption = streak.indexOf(
      "v_consumed_freeze := COALESCE((v_result ->> 'usedFreeze')::boolean, false)"
    );
    const historyRead = streak.indexOf('FROM unnest(v_frozen_dates)');
    const persistentResult = streak.indexOf("'usedFreeze', v_last_frozen_on IS NOT NULL");

    expect(captureConsumption).toBeGreaterThanOrEqual(0);
    expect(historyRead).toBeGreaterThan(captureConsumption);
    expect(persistentResult).toBeGreaterThan(historyRead);
    expect(streak).toContain('count(DISTINCT parsed.frozen_on)::integer');
    expect(streak).toContain('parsed.frozen_on BETWEEN v_started_on AND v_ended_on');
    expect(streak).toContain('AND NOT EXISTS (');
    expect(streak).toContain("'frozenDate', v_last_frozen_on");
    expect(streak).toContain("'lastFrozenDate', v_last_frozen_on");
    expect(streak).toContain("'honoredFrozenDates', v_honored_frozen_dates");
    expect(streak).toContain("'consumedFreeze', v_consumed_freeze");
    expect(streak).toContain("'consumedFrozenDate', v_consumed_frozen_on");
  });

  it('fails deployment if the private body becomes browser executable', () => {
    const verify = section(freezeMigration, 'DO $verify$', 'COMMIT;');
    expect(verify).toContain("has_function_privilege(\n    'authenticated'");
    expect(verify).toContain("'public.get_challenge_streak_calculate_body(uuid)'");
    expect(verify).toContain('Private Daily Missions streak calculator is browser executable');
  });

  it('does not bump dashboard revisions for timestamp-only streak refreshes', () => {
    const trigger = section(
      freezeMigration,
      'CREATE TRIGGER trg_daily_challenge_revision_from_streak\n',
      'ALTER FUNCTION public.get_challenge_streak(uuid)'
    );
    expect(trigger).toContain('AFTER UPDATE OF');
    expect(trigger).toContain('OLD.current_streak_length');
    expect(trigger).toContain('IS DISTINCT FROM ROW(');
    expect(trigger).not.toContain('OLD.updated_at');
    expect(trigger).toContain('CREATE TRIGGER trg_daily_challenge_revision_from_streak_lifecycle');
    expect(trigger).toContain('AFTER INSERT OR DELETE');
  });
});
