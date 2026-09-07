import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../supabase/migrations/20260831030000_daily_challenge_atomic_action_receipts.sql'
  ),
  'utf8'
);
const service = readFileSync(
  resolve(__dirname, '../src/services/DailyChallengeService.ts'),
  'utf8'
);
const page = readFileSync(resolve(__dirname, '../src/pages/DailyChallengesPage.tsx'), 'utf8');

describe('Daily Missions atomic action receipts', () => {
  it('claims an entire vault page in one replay-safe transaction', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.claim_daily_challenges');
    expect(migration).toContain('daily_challenge_claim_batches');
    expect(migration).toContain('PRIMARY KEY (user_id, request_id)');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain("v_existing || jsonb_build_object('replayed', true)");
    expect(migration).toContain("'challenge_claim_batch:' || p_request_id::text");
    expect(migration).toContain('public.atomic_credit_wallet_and_log(');
  });

  it('returns exact next-page vault and lifetime totals from the mutation transaction', () => {
    expect(migration).toContain("'claimedIds', to_jsonb(v_claimed_ids)");
    expect(migration).toContain("'alreadyClaimedIds', to_jsonb(v_already_claimed_ids)");
    expect(migration).toContain("'totalChipsEarned', v_total_chips");
    expect(migration).toContain("'items', v_vault_items");
    expect(migration).toContain("'hasMore', v_vault_count > VAULT_PAGE_SIZE");
  });

  it('replaces every immutable snapshot only inside the guarded reroll RPC', () => {
    expect(migration).toContain("current_setting('app.daily_challenge_reroll', true)");
    expect(migration).toContain("set_config('app.daily_challenge_reroll', '1', true)");
    expect(migration).toContain('BEFORE UPDATE OF challenge_id');
    expect(migration).toContain('NEW.challenge_name_snapshot');
    expect(migration).toContain("'challenge', jsonb_build_object(");
    expect(migration).toContain('v_row.tier_snapshot');
  });

  it('does not allow an anonymous caller to impersonate a user', () => {
    expect(migration).toContain('v_uid IS NULL AND public.fn_caller_is_engine()');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.claim_daily_challenges(uuid, uuid[], uuid) FROM PUBLIC, anon'
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.reroll_daily_challenge(uuid, uuid, text, integer) FROM PUBLIC, anon'
    );
    expect(migration).toContain("v_stack ~ 'function (public\\.)?claim_daily_challenge\\('");
    expect(migration).toContain("v_stack ~ 'function (public\\.)?claim_daily_challenges\\('");
  });

  it('wires both single and bulk claims to one RPC and installs only revision-fenced projections', () => {
    expect(service).toContain("supabase.rpc('claim_daily_challenges'");
    expect(service).toContain('p_request_id: requestId');
    expect(service).toMatch(/this\.mapServerChallenge\(\s*result\.challenge,\s*userId/);
    expect(page).toContain('dailyChallengeService.claimChallenges(userId, [challenge.id])');
    expect(page).toContain('dailyChallengeService.claimChallenges(userId, readyIds)');
    expect(page).toContain('installDashboardProjection(paid.dashboard)');
    expect(page).not.toContain('setRewardVault(paid.vault)');
    expect(page).not.toContain('setDiamondBalance(paid.diamondBalance)');
    expect(page).not.toContain('for (const c of ready)');
    expect(page).not.toContain('await loadChallenges(userId, false);');
  });

  it('serializes every balance-changing action and never paints an unconfirmed freeze debit', () => {
    expect(page).toContain('const economyGuardRef = useRef(false)');
    expect(page).toContain('const [economyBusy, setEconomyBusy] = useState(false)');
    expect(page.match(/economyGuardRef\.current = true/g)?.length).toBeGreaterThanOrEqual(4);
    expect(page).toContain('disabled={claiming || economyBusy}');
    expect(page).toContain('disabled={claimingAll || economyBusy}');
    expect(page).not.toContain('setDiamondBalance((prev) => Math.max(0, prev - 5000))');
    expect(page).not.toContain(
      'setStreak((prev) => (prev ? { ...prev, freezesAvailable: prev.freezesAvailable + 1 } : prev))'
    );

    const freezeSuccessStart = page.indexOf('if (res.success) {');
    const freezeSuccessEnd = page.indexOf('} else {', freezeSuccessStart);
    const freezeSuccess = page.slice(freezeSuccessStart, freezeSuccessEnd);
    expect(freezeSuccess).toContain('mutationEpochRef.current += 1');
    expect(freezeSuccess).toContain("await loadChallenges(userId, 'silent')");
    expect(freezeSuccess).not.toContain('setDiamondBalance(res.diamondBalance)');

    const rerollSuccess = page.indexOf(
      'setConfirmingRerollId(null)',
      page.indexOf('if (!result.success)')
    );
    const authoritativeReload = page.indexOf(
      "await loadChallenges(userId, 'silent')",
      rerollSuccess
    );
    const globalBalanceRefresh = page.indexOf(
      "masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_reroll', userId })",
      authoritativeReload
    );
    expect(rerollSuccess).toBeGreaterThan(-1);
    expect(authoritativeReload).toBeGreaterThan(rerollSuccess);
    expect(globalBalanceRefresh).toBeGreaterThan(authoritativeReload);
    expect(page).not.toContain('if (!result.challenge)');
    expect(page).not.toContain('setDiamondBalance(result.diamondBalance)');
    expect(page).not.toContain('result.challenge!');

    const rerollRefusalStart = page.indexOf('if (!result.success)');
    const rerollRefusalEnd = page.indexOf('setConfirmingRerollId(null)', rerollRefusalStart);
    expect(page.slice(rerollRefusalStart, rerollRefusalEnd)).toContain(
      "loadChallenges(userId, 'silent')"
    );
  });

  it('reconciles cross-device reroll and third-freeze presentation state', () => {
    expect(page).toContain(
      'if (!confirmingChallenge || confirmingChallenge.completed || confirmingChallenge.claimed)'
    );
    expect(page).toContain('setConfirmingRerollId(null)');
    expect(page).toContain("await loadChallenges(userId, 'silent')");
    expect(page).toContain('dashboard.revision < dashboardRevisionRef.current');
    expect(page).not.toContain('nextFreezeIn: freezesAvailable >= 3 ? null : prev.nextFreezeIn');
  });

  it('disables unaffordable rerolls while retaining the transaction-time balance guard', () => {
    expect(page).toContain('canAffordReroll={diamondBalance >= DAILY_MISSION_REROLL_COST}');
    expect(page).toContain('rerollConfirmationOpen || !canAffordReroll');
    expect(page).toContain('disabled={rerolling || economyBusy || !canAffordReroll}');
    expect(page).toContain('`Need ${DAILY_MISSION_REROLL_COST} Diamond To Reroll ${c.name}`');
    expect(page).toContain('if (diamondBalance < DAILY_MISSION_REROLL_COST)');
    const insufficientGuard = page.slice(
      page.indexOf('if (diamondBalance < DAILY_MISSION_REROLL_COST)'),
      page.indexOf('economyGuardRef.current = true', page.indexOf('handleReroll'))
    );
    expect(insufficientGuard).toContain('setConfirmingRerollId(null)');
    expect(insufficientGuard).toContain('Not Enough Diamonds');
  });
});
