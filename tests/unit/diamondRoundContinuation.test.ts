import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
import upgrades from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';
import DiamondGamesService, { normaliseCrash } from '../../src/services/DiamondGamesService';
import { DiamondChoiceService, parseChoiceRound } from '../../src/services/DiamondChoiceService';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const crash = fixtures.receipts.crash;
const expectedCrash = normaliseCrash({
  ...crash,
  status: 'open',
  outcome: null,
  multiplier_now_cents: 100,
  fairness: {
    commit_id: crash.fairness.commit_id,
    server_seed_hash: crash.fairness.server_seed_hash,
    client_seed: crash.fairness.client_seed,
    nonce: crash.fairness.nonce,
  },
});
beforeEach(() => rpc.mockReset());

describe('a Diamond game continuation keeps its accepted round', () => {
  it('retains the validated Super Crash budget through normalization of real server receipts', () => {
    const record = upgrades.records.find(
      (r) =>
        r.kind === 'start' &&
        r.game === 'crash' &&
        (r.value as Record<string, any>).bonus?.boost_multiplier === 2
    )!;
    const raw = record.value as Record<string, any>;
    const normalized = normaliseCrash(raw);
    expect(normalized.award_id).toBe(raw.award_id);
    expect(normalized.bonus).toMatchObject({
      base_diamonds: 5000,
      entry_diamonds: 2500,
      boost_multiplier: 2,
      added_diamonds: 2500,
      total_diamonds: 7500,
    });
    expect(normalized.bet_diamonds).toBe(7500);
    expect(normaliseCrash(normalized as unknown as Record<string, unknown>).bonus).toEqual(
      normalized.bonus
    );
    for (const change of [
      { boost_multiplier: 1 },
      { base_diamonds: 2500 },
      { total_diamonds: 5000 },
      { added_diamonds: 5000 },
    ]) {
      expect(() => normaliseCrash({ ...raw, bonus: { ...raw.bonus, ...change } })).toThrow(
        'Award Could Not Be Verified'
      );
    }
    expect(normaliseCrash(crash).bonus).toBeUndefined();
    expect(normaliseCrash({ ...crash, award_id: null }).bonus).toBeUndefined();
    for (const award_id of ['', 'invalid', 2, false]) {
      expect(() => normaliseCrash({ ...crash, award_id })).toThrow('Award Could Not Be Verified');
    }
  });
  it('sends the clicked hundredth unchanged to the authenticated cash-out endpoint', async () => {
    rpc.mockResolvedValue({ data: crash, error: null });
    await DiamondGamesService.crashSettle(crash.round_id, true, expectedCrash, 257);
    expect(rpc).toHaveBeenCalledWith('fn_crash_cashout', {
      p_round_id: crash.round_id,
      p_multiplier_cents: 257,
    });
  });
  it.each([100, 257.5, NaN, Infinity])(
    'refuses an invalid clicked multiplier %s before sending',
    async (cents) => {
      await expect(
        DiamondGamesService.crashSettle(crash.round_id, true, expectedCrash, cents)
      ).rejects.toThrow('Cash Out Starts At 1.01x');
      expect(rpc).not.toHaveBeenCalled();
    }
  );
  it('accepts the saved PostgreSQL Crash settlement for the same round', async () => {
    rpc.mockResolvedValue({ data: crash, error: null });
    const result = await DiamondGamesService.crashSettle(crash.round_id, true, expectedCrash);
    expect(result.outcome?.payout_chips).toBe(crash.outcome.payout_chips);
  });
  it.each([undefined, null, 'true', 'false', 1])(
    'rejects unconfirmed Crash status %s',
    async (ok) => {
      rpc.mockResolvedValue({ data: { ...crash, ok }, error: null });
      await expect(
        DiamondGamesService.crashSettle(crash.round_id, true, expectedCrash)
      ).rejects.toThrow('Could Not Be Verified');
    }
  );
  it.each([undefined, null, '1.28', -1, 0.001, Infinity])(
    'never normalizes an invalid payout %s to a booked result',
    async (payout_chips) => {
      rpc.mockResolvedValue({
        data: { ...crash, outcome: { ...crash.outcome, payout_chips } },
        error: null,
      });
      await expect(
        DiamondGamesService.crashSettle(crash.round_id, false, expectedCrash)
      ).rejects.toThrow();
    }
  );
  it('rejects a different round or changed accepted commitment, bet, or cap', async () => {
    for (const change of [
      { round_id: '00000000-0000-0000-0000-000000000001' },
      { fairness: { ...crash.fairness, server_seed_hash: 'f'.repeat(64) } },
      { bet_diamonds: 200 },
      { cap_cents: 200000 },
      { outcome: { ...crash.outcome, crash_cents: 233 } },
    ]) {
      rpc.mockResolvedValueOnce({ data: { ...crash, ...change }, error: null });
      await expect(
        DiamondGamesService.crashSettle(crash.round_id, false, expectedCrash)
      ).rejects.toThrow();
    }
  });
  it('keeps a confirmed refusal separate from a result and rejects an open seed leak', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'Maintenance Break', frozen: true },
      error: null,
    });
    expect((await DiamondGamesService.crashSettle(crash.round_id, false, expectedCrash)).ok).toBe(
      false
    );
    rpc.mockResolvedValueOnce({ data: expectedCrash, error: null });
    expect(
      (await DiamondGamesService.crashSettle(crash.round_id, false, expectedCrash)).status
    ).toBe('open');
    rpc.mockResolvedValueOnce({
      data: { ...expectedCrash, fairness: crash.fairness },
      error: null,
    });
    await expect(
      DiamondGamesService.crashSettle(crash.round_id, false, expectedCrash)
    ).rejects.toThrow();
  });
  it.each(['mines', 'crossing'] as const)(
    'binds %s actions to their original game and ordered picks',
    async (game) => {
      const settled = fixtures.receipts[game];
      const open = parseChoiceRound({ ...settled, status: 'open', proof: null, payout_chips: 0 });
      rpc.mockResolvedValueOnce({ data: settled, error: null });
      await expect(DiamondChoiceService.act(open, 'cashout', null)).resolves.toEqual(settled);
      expect(rpc).toHaveBeenLastCalledWith('fn_choice_act', {
        p_round_id: open.id,
        p_action: 'cashout',
        p_cell: null,
        p_expected_step: open.picked.length,
      });
      for (const change of [
        { id: '00000000-0000-0000-0000-000000000001' },
        { commit_id: '00000000-0000-0000-0000-000000000002' },
        { prizes: settled.prizes.map((prize) => prize + 1) },
        { status: 'open', proof: null, payout_chips: 0, picked: [] },
      ]) {
        rpc.mockResolvedValueOnce({ data: { ...settled, ...change }, error: null });
        await expect(DiamondChoiceService.act(open, 'pick', 1)).rejects.toThrow();
      }
    }
  );
});

it('retains the accepted Choice award identity and funding through every later action', async () => {
  const raw = fixtures.receipts.mines;
  const original = {
    ...raw,
    award_id: '00000000-0000-0000-0000-000000000071',
    bet_diamonds: 200,
    bet_chips: 2,
    bonus: {
      id: raw.id,
      base_diamonds: 200,
      added_diamonds: 0,
      total_diamonds: 200,
      entry_diamonds: 100,
      boost_multiplier: 2,
    },
  };
  const open = parseChoiceRound({ ...original, status: 'open', proof: null, payout_chips: 0 });
  rpc.mockResolvedValueOnce({ error: null, data: original });
  await expect(DiamondChoiceService.act(open, 'cashout', null)).resolves.toEqual(original);
  rpc.mockResolvedValueOnce({
    error: null,
    data: {
      ...original,
      bonus: { ...original.bonus, base_diamonds: 100, added_diamonds: 100, boost_multiplier: 1 },
    },
  });
  await expect(DiamondChoiceService.act(open, 'cashout', null)).rejects.toThrow('Does Not Match');
  rpc.mockResolvedValueOnce({
    error: null,
    data: { ...original, award_id: '00000000-0000-0000-0000-000000000072' },
  });
  await expect(DiamondChoiceService.act(open, 'cashout', null)).rejects.toThrow('Does Not Match');
});
