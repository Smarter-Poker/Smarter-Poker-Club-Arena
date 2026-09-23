import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));

import {
  ClubOpeningSetupError,
  clubOpeningSetupService,
  isDefinitiveOpeningSetupRefusal,
  openingLeaderboardBudgetSplitsEvenly,
  openingLeaderboardFundingCapacity,
  openingLeaderboardFundingRefusal,
  openingLeaderboardPrizeSplit,
  presentOpeningSetupRefusal,
  type ClubOpeningSetupInput,
} from '../../src/services/ClubOpeningSetupService';

const root = resolve(__dirname, '../..');
const openingSql = readFileSync(
  resolve(root, 'supabase/migrations/20260901073000_club_opening_setup_wizard.sql'),
  'utf8'
);
const fundingGateSql = readFileSync(
  resolve(root, 'supabase/migrations/20260906003717_leaderboard_phase3_funded_publication.sql'),
  'utf8'
);
const settlementSql = readFileSync(
  resolve(
    root,
    'supabase/migrations/20260906084547_leaderboard_phase_4_promo_only_settlement_truth.sql'
  ),
  'utf8'
);
const wizardSource = readFileSync(
  resolve(root, 'src/components/club/ClubOpeningWizard.tsx'),
  'utf8'
);

const input: ClubOpeningSetupInput = {
  clubId: 'club-1',
  tagline: 'Where The River Always Pays',
  rakePercent: -1,
  rakeCapBB: -1,
  bbjEnabled: false,
  bbjSeed: 100,
  spinsEnabled: false,
  spinSeed: 200,
  spinMaxStake: 1,
  promoEnabled: true,
  promoType: 'high_hand',
  promoName: 'Opening High Hand',
  promoDescription: 'Play',
  promoBudget: 500,
  leaderboardRewardsEnabled: true,
  leaderboardMetric: 'profit',
  leaderboardPrizeBudget: 500,
};

beforeEach(() => vi.resetAllMocks());

describe('opening leaderboard funding gate, mirrored from the live SQL', () => {
  it('pins the server condition this rule mirrors', () => {
    // The RPC credits the Promotion budget to the Promo Wallet BEFORE publishing.
    expect(openingSql).toContain('promo_balance = COALESCE(promo_balance, 0) + v_promo_budget');
    expect(
      openingSql.indexOf('promo_balance = COALESCE(promo_balance, 0) + v_promo_budget')
    ).toBeLessThan(
      openingSql.indexOf('v_leaderboard_result := public.fn_publish_leaderboard_reward_program(')
    );
    // The trigger compares the program commitment with clubs.promo_balance only.
    expect(fundingGateSql).toContain('SELECT COALESCE(club.promo_balance, 0)');
    expect(fundingGateSql).toContain(
      'IF v_requested_commitment + v_other_commitments > v_balance THEN'
    );
    expect(fundingGateSql).toContain('BEFORE INSERT ON public.leaderboard_reward_program_versions');
  });

  it('accepts a prize budget up to the promotion budget and refuses one chip more', () => {
    const base = { promoEnabled: true, promoBudget: 500 };
    expect(openingLeaderboardFundingRefusal({ ...base, leaderboardPrizeBudget: 100 })).toBe('');
    expect(openingLeaderboardFundingRefusal({ ...base, leaderboardPrizeBudget: 500 })).toBe('');
    expect(openingLeaderboardFundingRefusal({ ...base, leaderboardPrizeBudget: 510 })).toBe(
      'Weekly Prize Budget Cannot Exceed The 500 Chip Promotion Budget. Raise The Promotion Budget Or Lower The Prize Budget'
    );
  });

  it('refuses every paid budget when no promotion is funded', () => {
    for (const promo of [
      { promoEnabled: false, promoBudget: 5000 },
      { promoEnabled: true, promoBudget: 0 },
    ]) {
      expect(openingLeaderboardFundingCapacity(promo)).toBe(0);
      expect(openingLeaderboardFundingRefusal({ ...promo, leaderboardPrizeBudget: 100 })).toBe(
        'Paid Leaderboards Need A Promotion Budget Of At Least 100 Chips. Go Back And Create A Promotion, Or Choose Display Only'
      );
    }
  });

  it('counts Promo Wallet chips the club already holds, and ignores junk', () => {
    expect(
      openingLeaderboardFundingRefusal({
        promoEnabled: false,
        promoBudget: 0,
        existingPromoBalance: 1000,
        leaderboardPrizeBudget: 1000,
      })
    ).toBe('');
    expect(
      openingLeaderboardFundingCapacity({
        promoEnabled: true,
        promoBudget: 300,
        existingPromoBalance: -50,
      })
    ).toBe(300);
    expect(
      openingLeaderboardFundingCapacity({
        promoEnabled: true,
        promoBudget: 300,
        existingPromoBalance: null,
      })
    ).toBe(300);
  });

  it('prints the cap compact, the minimum it asks for in full, and never an em dash', () => {
    const message = openingLeaderboardFundingRefusal({
      promoEnabled: true,
      promoBudget: 12500,
      leaderboardPrizeBudget: 20000,
    });
    expect(message).toContain('Cannot Exceed The 12.5K Chip Promotion Budget');
    expect(
      openingLeaderboardFundingRefusal({
        promoEnabled: false,
        promoBudget: 0,
        leaderboardPrizeBudget: 1250,
      })
    ).toContain('A Promotion Budget Of At Least 1,250 Chips');
    expect(message).not.toMatch(/—|\d\.\d{2}/);
  });
});

describe('opening leaderboard prize split preview', () => {
  /* The server: round(B * 0.50, 2), round(B * 0.30, 2), remainder to third. */
  const serverSplit = (budget: number) => {
    const first = Math.round(budget * 0.5 * 100) / 100;
    const second = Math.round(budget * 0.3 * 100) / 100;
    return { first, second, third: Math.round((budget - first - second) * 100) / 100 };
  };

  it('pins the server formula it must agree with', () => {
    expect(openingSql).toContain("'amount', round(v_leaderboard_budget * 0.50, 2)");
    expect(openingSql).toContain("'amount', round(v_leaderboard_budget * 0.30, 2)");
  });

  it('is whole chips that always sum exactly to the budget', () => {
    for (const budget of [0, 1, 99, 100, 101, 105, 333, 500, 999, 1000, 1234567]) {
      const split = openingLeaderboardPrizeSplit(budget);
      expect(Number.isInteger(split.first)).toBe(true);
      expect(Number.isInteger(split.second)).toBe(true);
      expect(Number.isInteger(split.third)).toBe(true);
      expect(split.first + split.second + split.third).toBe(budget);
      expect(split.first).toBeGreaterThanOrEqual(split.second);
    }
    expect(openingLeaderboardPrizeSplit(105)).toEqual({ first: 53, second: 31, third: 21 });
    expect(openingLeaderboardPrizeSplit(250.75)).toEqual({ first: 125, second: 75, third: 50 });
  });

  it('equals the server split for every budget the wizard accepts', () => {
    for (let budget = 100; budget <= 20000; budget += 10) {
      expect(openingLeaderboardBudgetSplitsEvenly(budget)).toBe(true);
      expect(openingLeaderboardPrizeSplit(budget)).toEqual(serverSplit(budget));
    }
  });

  it('refuses budgets whose server split would carry decimals', () => {
    for (const budget of [101, 105, 333, 100.5, 0, -10]) {
      expect(openingLeaderboardBudgetSplitsEvenly(budget)).toBe(false);
    }
    expect(serverSplit(105).first).toBe(52.5);
  });
});

describe('opening setup request key and refusals', () => {
  it('sends the caller key and never mints its own', async () => {
    mocks.rpc.mockResolvedValue({
      data: {
        success: true,
        already_completed: false,
        club_bank_after: 99000,
        operation_id: 'key-1',
      },
      error: null,
    });
    const spy = vi.spyOn(crypto, 'randomUUID');
    await clubOpeningSetupService.complete(input, 'key-1');
    await clubOpeningSetupService.complete(input, 'key-1');
    expect(spy).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    for (const call of mocks.rpc.mock.calls) {
      expect(call[0]).toBe('fn_complete_club_opening_setup');
      expect(call[1].p_operation_id).toBe('key-1');
    }
    spy.mockRestore();
  });

  it('keeps the RPC payload contract: eighteen named arguments, disabled seeds zeroed', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, already_completed: false, club_bank_after: 1, operation_id: 'k' },
      error: null,
    });
    await clubOpeningSetupService.complete(input, 'k');
    expect(mocks.rpc.mock.calls[0][1]).toEqual({
      p_club_id: 'club-1',
      p_operation_id: 'k',
      p_tagline: 'Where The River Always Pays',
      p_rake_percent: -1,
      p_rake_cap_bb: -1,
      p_bbj_enabled: false,
      p_bbj_seed: 0,
      p_spins_enabled: false,
      p_spin_seed: 0,
      p_spin_max_stake: 0,
      p_promo_enabled: true,
      p_promo_type: 'high_hand',
      p_promo_name: 'Opening High Hand',
      p_promo_description: 'Play',
      p_promo_budget: 500,
      p_leaderboard_rewards_enabled: true,
      p_leaderboard_metric: 'profit',
      p_leaderboard_prize_budget: 500,
    });
  });

  it('refuses to call the server without a key', async () => {
    await expect(clubOpeningSetupService.complete(input, '')).rejects.toThrow(
      'Operation ID Is Required'
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('marks a coded database refusal definitive and prints its reason without decimals', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'Club Bank Has 500.75 Chips But Setup Requires 1600.00', code: 'P0001' },
    });
    const error = await clubOpeningSetupService.complete(input, 'k').catch((e) => e);
    expect(error).toBeInstanceOf(ClubOpeningSetupError);
    expect(error.message).toBe('Club Bank Has 500 Chips But Setup Requires 1,600');
    expect(error.definitive).toBe(true);
    expect(isDefinitiveOpeningSetupRefusal(error)).toBe(true);
  });

  it('marks a lost response indefinite and never prints the raw fetch error', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' },
    });
    const error = await clubOpeningSetupService.complete(input, 'k').catch((e) => e);
    expect(error).toBeInstanceOf(ClubOpeningSetupError);
    expect(error.definitive).toBe(false);
    expect(error.message).toBe(
      'Club Opening Setup Could Not Be Confirmed. Check Your Connection And Try Again'
    );
    expect(isDefinitiveOpeningSetupRefusal(error)).toBe(false);
    expect(isDefinitiveOpeningSetupRefusal(new TypeError('Failed to fetch'))).toBe(false);
    expect(isDefinitiveOpeningSetupRefusal(null)).toBe(false);
  });

  it('reads the applied state with maybeSingle and reports a read error', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { tagline: 'Saved Line', spins_enabled: true },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ select });
    await expect(clubOpeningSetupService.getAppliedState('club-1')).resolves.toEqual({
      tagline: 'Saved Line',
      spinsEnabled: true,
    });
    expect(mocks.from).toHaveBeenCalledWith('clubs');
    expect(eq).toHaveBeenCalledWith('id', 'club-1');

    maybeSingle.mockResolvedValue({ data: null, error: { message: 'Denied', code: '42501' } });
    await expect(clubOpeningSetupService.getAppliedState('club-1')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('a server refusal, fit to print', () => {
  it('floors every chip figure to a whole chip with separators', () => {
    expect(
      presentOpeningSetupRefusal(
        'Leaderboard Prize Program Requires 1000.00 Promo Chips But Only 500.00 Are Available After Other Published Commitments'
      )
    ).toBe(
      'Leaderboard Prize Program Requires 1,000 Promo Chips But Only 500 Are Available After Other Published Commitments'
    );
    expect(
      presentOpeningSetupRefusal('Spin Seed Must Be At Least 20000.00 Chips For The Selected Board')
    ).toBe('Spin Seed Must Be At Least 20,000 Chips For The Selected Board');
    expect(presentOpeningSetupRefusal('A New Promotion Requires A Minimum 100-Chip Budget')).toBe(
      'A New Promotion Requires A Minimum 100-Chip Budget'
    );
  });

  it('keeps a percentage rate as written', () => {
    expect(presentOpeningSetupRefusal('Rake Above 12.5% Is Not Allowed')).toBe(
      'Rake Above 12.5% Is Not Allowed'
    );
  });

  it('never shows a raw database message or an internal identifier', () => {
    for (const raw of [
      'permission denied for function fn_complete_club_opening_setup',
      'Spin Setup Failed: insufficient_funds',
      '',
      null,
      undefined,
    ]) {
      expect(presentOpeningSetupRefusal(raw)).toBe(
        'Club Opening Setup Was Refused. Nothing Was Deducted'
      );
    }
  });
});

describe('the review copy describes the live settlement SQL', () => {
  it('pays a standalone round from the seed and the Promo Wallet only, never the Club Bank', () => {
    // Seed first, then the Promo Wallet, and the unused seed is released into it.
    expect(settlementSql).toContain('v_seed_debit := LEAST(v_total, v_seed_available);');
    expect(settlementSql).toContain('v_promo_debit := v_total - v_seed_debit;');
    expect(settlementSql).toContain(
      'SET promo_balance = promo_balance - v_promo_debit + v_seed_release,'
    );
    // An underfunded round is refused and left for the automatic retry.
    expect(settlementSql).toContain('LEADERBOARD_PROMO_UNDERFUNDED|');
    expect(settlementSql).toContain('Automatic Retry Is Active');
    // No overlay: the batch records 0 overlay and nothing debits chip_treasury.
    expect(settlementSql).toContain("'overlay_funded', 0,");
    expect(settlementSql).not.toMatch(/chip_treasury\s*=\s*chip_treasury\s*-/);
    // And the opening RPC holds the seed outside the Promo Wallet.
    expect(openingSql).toContain('leaderboard_seed_remaining,');
    expect(openingSql).toContain('promo_balance = COALESCE(promo_balance, 0) + v_promo_budget,');
  });

  it('prints that behavior and no longer promises an overlay', () => {
    // JSX copy wraps across source lines; compare it with whitespace folded.
    const copy = wizardSource.replace(/\s+/g, ' ');
    expect(copy).toContain('Held As The First-Round Prize Seed, Outside The Promo Wallet');
    expect(copy).toContain('That Round Stays Unpaid And Is Retried Automatically');
    expect(copy).toContain('No Round');
    expect(copy).not.toContain('Covers Any Overlay');
    expect(copy).not.toContain('Reserved In The Promo Wallet');
  });
});
