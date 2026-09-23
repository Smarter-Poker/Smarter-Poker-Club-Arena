import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: mocks }));

import {
  ClubOpeningSetupError,
  clubOpeningSetupService,
  isDefinitiveOpeningSetupRefusal,
  OPENING_LEADERBOARD_MINIMUM_BUDGET,
  openingLeaderboardBudgetSplitsEvenly,
  openingLeaderboardFundingCapacity,
  openingLeaderboardFundingRefusal,
  openingLeaderboardPrizeSplit,
  presentOpeningSetupRefusal,
  type ClubOpeningSetupInput,
} from '../../src/services/ClubOpeningSetupService';

const root = resolve(__dirname, '../..');
const migrations = resolve(root, 'supabase/migrations');

/**
 * The LIVE rule for a function is its newest definition: migrations apply in
 * version order, so an older file defining it is history. Newest first, the
 * first file that (re)creates the function wins, and only that function's own
 * statement is returned, so a pin cannot be satisfied by some other function
 * in the same file.
 */
function liveDefinitionOf(fn: string): string {
  const create = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\(`);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .reverse()) {
    const sql = readFileSync(resolve(migrations, file), 'utf8');
    const start = sql.search(create);
    if (start < 0) continue;
    const bodyOpen = sql.indexOf('$function$', start);
    const bodyClose = sql.indexOf('$function$', bodyOpen + 10);
    expect(bodyClose, `${fn} in ${file} has no closing $function$`).toBeGreaterThan(bodyOpen);
    return sql.slice(start, bodyClose + 10);
  }
  throw new Error(`No migration defines public.${fn}`);
}

const openingSql = liveDefinitionOf('fn_complete_club_opening_setup');
const fundingGateSql = liveDefinitionOf('fn_enforce_leaderboard_program_funding');
const settlementSql = liveDefinitionOf('fn_payout_leaderboard');
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
  leaderboardOverlayEnabled: false,
};

beforeEach(() => vi.resetAllMocks());

describe('opening leaderboard funding gate, mirrored from the live SQL', () => {
  it('pins the server condition this rule mirrors: the seed is written first and counted', () => {
    // The RPC writes the setup row that holds the seed BEFORE it publishes.
    const setupRow = openingSql.indexOf('INSERT INTO public.club_opening_setups (');
    const publish = openingSql.indexOf(
      'v_leaderboard_result := public.fn_publish_leaderboard_reward_program('
    );
    expect(setupRow).toBeGreaterThan(-1);
    expect(setupRow).toBeLessThan(publish);
    // The seed is the whole weekly budget, and the plan sums exactly to it.
    expect(openingSql).toMatch(
      /v_leaderboard_budget,\s*v_leaderboard_budget,\s*p_operation_id\s*\);/
    );
    // The gate counts the unreleased opening seed for the setup's own publication only.
    expect(fundingGateSql).toContain('SELECT COALESCE(club.promo_balance, 0)');
    expect(fundingGateSql).toContain('FROM public.club_opening_setups setup');
    expect(fundingGateSql).toContain('AND setup.last_operation_id = NEW.operation_id');
    expect(fundingGateSql).toContain('v_balance := v_balance + COALESCE(v_opening_seed, 0);');
    expect(fundingGateSql).toContain(
      'IF v_requested_commitment + v_other_commitments > v_balance THEN'
    );
    // What the server still refuses about the budget itself.
    expect(openingSql).toContain('IF v_leaderboard_budget < 100 THEN');
    expect(openingSql).toContain('A Prize Leaderboard Requires A Minimum 100-Chip Budget');
  });

  it('accepts every paid budget from the minimum up, with or without a promotion', () => {
    for (const budget of [100, 500, 1000, 12500, 1000000]) {
      expect(openingLeaderboardFundingRefusal({ leaderboardPrizeBudget: budget })).toBe('');
    }
    expect(OPENING_LEADERBOARD_MINIMUM_BUDGET).toBe(100);
  });

  it('refuses only what the server refuses: a paid budget under 100 chips', () => {
    for (const budget of [0, 10, 99, 99.99, -500, Number.NaN]) {
      expect(openingLeaderboardFundingRefusal({ leaderboardPrizeBudget: budget })).toBe(
        'Leaderboard Prize Budget Must Be At Least 100 Chips'
      );
    }
    expect(openingLeaderboardFundingRefusal({ leaderboardPrizeBudget: 50 })).not.toMatch(
      /—|\d\.\d{2}/
    );
  });

  it('reports the Promo Wallet every later round draws on, and ignores junk', () => {
    expect(openingLeaderboardFundingCapacity({ promoEnabled: false, promoBudget: 5000 })).toBe(0);
    expect(openingLeaderboardFundingCapacity({ promoEnabled: true, promoBudget: 500 })).toBe(500);
    expect(
      openingLeaderboardFundingCapacity({
        promoEnabled: false,
        promoBudget: 0,
        existingPromoBalance: 1000,
      })
    ).toBe(1000);
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

  it('adds the Club Bank overlay as a nineteenth argument only when the owner allowed it', async () => {
    mocks.rpc.mockResolvedValue({
      data: { success: true, already_completed: false, club_bank_after: 1, operation_id: 'k' },
      error: null,
    });
    await clubOpeningSetupService.complete({ ...input, leaderboardOverlayEnabled: true }, 'k');
    expect(mocks.rpc.mock.calls[0][1]).toMatchObject({ p_leaderboard_overlay_enabled: true });
    expect(Object.keys(mocks.rpc.mock.calls[0][1])).toHaveLength(19);

    // A Display Only leaderboard never carries it, whatever the answer was.
    await clubOpeningSetupService.complete(
      { ...input, leaderboardRewardsEnabled: false, leaderboardOverlayEnabled: true },
      'k'
    );
    expect(mocks.rpc.mock.calls[1][1]).not.toHaveProperty('p_leaderboard_overlay_enabled');
    // "Leave Unpaid Until Funded" is today's payload: the server's default is OFF.
    await clubOpeningSetupService.complete(input, 'k');
    expect(mocks.rpc.mock.calls[2][1]).not.toHaveProperty('p_leaderboard_overlay_enabled');
    expect(Object.keys(mocks.rpc.mock.calls[2][1])).toHaveLength(18);
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
  it('pays from the seed, then the Promo Wallet, and the Club Bank only with the opt-in', () => {
    // Seed first, then the Promo Wallet, and the unused seed is released into it.
    expect(settlementSql).toContain('v_seed_debit := LEAST(v_total, v_seed_available);');
    expect(settlementSql).toContain('v_promo_debit := v_total - v_seed_debit - v_overlay;');
    expect(settlementSql).toContain(
      'SET promo_balance = promo_balance - v_promo_debit + v_seed_release,'
    );
    // Without the opt-in an underfunded round is refused exactly as before and retried.
    expect(settlementSql).toMatch(
      /IF NOT v_overlay_enabled THEN\s*RAISE EXCEPTION\s*'LEADERBOARD_PROMO_UNDERFUNDED\|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %'/
    );
    // The opt-in is read from the round's own immutable program version.
    expect(settlementSql).toContain('SELECT program.overlay_enabled');
    expect(settlementSql).toContain("AND program.funding_owner_type = 'club';");
    // Only the shortfall is an overlay, only a Club Bank that holds all of it pays it.
    expect(settlementSql).toContain('v_overlay := v_total - v_seed_available - v_promo_available;');
    expect(settlementSql).toMatch(
      /IF v_bank_available < v_overlay THEN\s*RAISE EXCEPTION\s*'LEADERBOARD_PROMO_UNDERFUNDED\|/
    );
    // The overlay is its own journal leg under its own key, recorded on the batch.
    const leg = settlementSql.slice(settlementSql.indexOf('IF v_overlay > 0 THEN'));
    expect(leg).toMatch(
      /set_config\('app\.ledger_category', 'overlay', true\);[\s\S]*leaderboard-overlay:%s:%s:%s[\s\S]*SET chip_treasury = chip_treasury - v_overlay,/
    );
    expect(settlementSql.match(/chip_treasury\s*=\s*chip_treasury\s*-/g)).toHaveLength(1);
    expect(settlementSql).toContain('v_total, v_seed_debit, v_promo_debit, v_overlay,');
    expect(settlementSql).toContain("'overlay_funded', v_overlay,");
    // And the opening RPC still holds the seed outside the Promo Wallet.
    expect(openingSql).toContain('leaderboard_seed_remaining,');
    expect(openingSql).toContain('promo_balance = COALESCE(promo_balance, 0) + v_promo_budget,');
  });

  it('prints that behavior for either answer and never promises what the SQL does not do', () => {
    // JSX copy wraps across source lines; compare it with whitespace folded.
    const copy = wizardSource.replace(/\s+/g, ' ');
    expect(copy).toContain(
      'The Weekly Prize Pool. Round One Is Seeded From The Club Bank When Setup Completes, Held Outside The Promo Wallet'
    );
    expect(copy).toContain('That Round Stays Unpaid And Is Retried Automatically.');
    expect(copy).toContain('The Club Bank Never Pays A Round Of This Leaderboard.');
    expect(copy).toContain(
      'The Club Bank Pays Only That Shortfall, Recorded As A Separate Overlay.'
    );
    expect(copy).not.toContain('No Round Is Ever Paid From The Club Bank');
    expect(copy).not.toContain('Covers Any Overlay');
    expect(copy).not.toContain('Reserved In The Promo Wallet');
  });
});
