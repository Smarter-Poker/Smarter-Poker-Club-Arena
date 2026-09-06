import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');

const page = read('src/pages/DailyChallengesPage.tsx');
const service = read('src/services/DailyChallengeService.ts');
const migration = read(
  'supabase/migrations/20260906141022_daily_mission_rerolls_cost_one_diamond.sql'
);
const replayHardening = read(
  'supabase/migrations/20260906145129_daily_mission_reroll_replay_proof_and_current_projection.sql'
);
const pageObject = read('tests/e2e/support/DailyMissionsPage.ts');
const production = read('tests/e2e/production-daily-missions.spec.ts');

function section(start: string, end: string): string {
  const startAt = migration.indexOf(start);
  const endAt = migration.indexOf(end, startAt + start.length);
  expect(startAt, `Missing Section Start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endAt, `Missing Section End: ${end}`).toBeGreaterThan(startAt);
  return migration.slice(startAt, endAt);
}

describe('Daily Mission one-Diamond reroll contract', () => {
  it('uses one shared client price for UI, RPC validation, balance events, and telemetry', () => {
    expect(service).toContain('export const DAILY_MISSION_REROLL_COST = 1 as const');
    expect(service).toContain('p_cost: DAILY_MISSION_REROLL_COST');
    expect(service).toContain('alreadyRerolled ? 0 : DAILY_MISSION_REROLL_COST');
    expect(service).toContain('never publish');
    expect(service).toContain('diamondsSpent,');

    expect(page).toContain('diamondBalance < DAILY_MISSION_REROLL_COST');
    expect(page).toContain('Reroll ${DAILY_MISSION_REROLL_COST} Diamond For ${c.name}');
    expect(page).toContain('diamond_cost: result.diamondsSpent ?? 0');
    expect(page).not.toMatch(/Reroll 10|10 Diamonds Required|diamond_cost:\s*10/);
  });

  it('charges fresh five-argument requests one Diamond after replaying exact history', () => {
    const fiveArg = section(
      'CREATE OR REPLACE FUNCTION public.reroll_daily_challenge(\n  p_user_id uuid,\n  p_challenge_row_id uuid,\n  p_expected_challenge_id text,\n  p_cost integer,\n  p_request_id uuid',
      'REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer, uuid)'
    );
    const receiptLookup = fiveArg.indexOf('FROM public.daily_challenge_reroll_receipts');
    const priceGuard = fiveArg.indexOf('IF p_cost IS DISTINCT FROM REROLL_COST');

    expect(fiveArg).toContain('REROLL_COST constant integer := 1');
    expect(receiptLookup).toBeGreaterThanOrEqual(0);
    expect(priceGuard).toBeGreaterThan(receiptLookup);
    expect(fiveArg).toContain("'diamondsSpent', 0");
    expect(fiveArg).toContain('p_amount           := REROLL_COST');
    expect(fiveArg).toContain("p_reference_id     := 'challenge_reroll:' || p_request_id::text");
    expect(fiveArg).toContain("'diamondsSpent', REROLL_COST");
  });

  it('keeps historical receipts immutable while closing every old ten-Diamond path', () => {
    expect(migration).toContain('CHECK (cost IN (1, 10))');
    expect(migration).toContain('p_cost integer DEFAULT 1');
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.reroll_daily_challenge_legacy_serialized_body('
    );
    expect(migration).toContain('FROM PUBLIC, anon');
    expect(migration).toContain('TO authenticated, service_role');
    expect(migration).toContain('DO $verify$');

    const fourArg = section(
      '-- The four-argument path stays available',
      'REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer)'
    );
    expect(fourArg.indexOf('IF v_row.challenge_id IS DISTINCT')).toBeLessThan(
      fourArg.indexOf('IF p_cost IS DISTINCT FROM REROLL_COST')
    );
    expect(fourArg).toContain("'diamondsSpent', 0");
    expect(fourArg).toContain('gen_random_uuid()');
  });

  it('certifies the singular price and exact one-Diamond settlement in production', () => {
    expect(pageObject).toContain('/^Reroll 1 Diamond For .+$/');
    expect(production).toContain('reroll confirmation charges one diamond exactly once');
    expect(production).toContain('p_cost: 1');
    expect(production).toContain('diamondsSpent: 1');
    expect(production).toContain('toBe(balanceBefore - 1)');
    expect(production).toContain('toBe(-1)');
    expect(production).toContain('toBe(balanceBefore - 2)');
  });

  it('never publishes a stored replay projection and requires legacy settlement proof', () => {
    expect(service).toContain('if (alreadyRerolled)');
    expect(service).toContain('let the page reload the live dashboard');
    expect(page).toContain("await loadChallenges(userId, 'silent')");
    expect(replayHardening).toContain("'refreshRequired', true");
    expect(replayHardening).toContain('daily_challenge_reroll_receipts receipt');
    expect(replayHardening).toContain('receipt.cost = p_cost');
    expect(replayHardening).toContain('p_cost IS NULL OR p_cost NOT IN (1, 10)');
    expect(replayHardening).toContain(
      "'challenge_reroll:' || p_challenge_row_id::text || ':' || p_expected_challenge_id"
    );
    expect(replayHardening).toContain("journal.transaction_type = 'daily_challenge_reroll'");
    expect(replayHardening).toContain("journal.type = 'daily_challenge_reroll'");
    expect(replayHardening).toContain(
      "journal.metadata ->> 'challenge_row_id' = p_challenge_row_id::text"
    );
    expect(replayHardening).toContain(
      "journal.metadata ->> 'from_challenge_id' = p_expected_challenge_id"
    );
    expect(replayHardening).toContain('IF v_has_replay_proof THEN');
    expect(replayHardening).toContain('NULL::text');
    expect(production).toContain("expect(replay).not.toHaveProperty('diamondBalance')");
    expect(production).toContain('inventedExpectedId');
    expect(production).toContain('p_cost: -2147483648');
    expect(production).toContain('cycledReceiptRequestId');
    expect(production).toContain('daily_mission_legacy_journal_replay');
    expect(production).toContain("transaction_type: 'daily_challenge_reroll'");
  });

  it('reconciles every successful response before painting its potentially older projection', () => {
    const handler = page.slice(
      page.indexOf('const handleReroll = useCallback'),
      page.indexOf('const handleClaimAll = useCallback')
    );
    expect(handler).toContain("await loadChallenges(userId, 'silent')");
    expect(handler).not.toContain('setDiamondBalance(result.diamondBalance)');
    expect(handler).not.toContain('result.challenge!');
    expect(handler).toContain(
      "masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_reroll', userId })"
    );
    expect(service).toContain('the page reconciles the live dashboard');
  });
});
