import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';
import cents from '../fixtures/diamond-spins/fractional-cent-vectors.json';
import {
  DiamondBonusService,
  parsePlinkoBonus,
  validateBonusReceipt,
  type BonusStart,
} from '../../src/services/DiamondBonusService';
import { parseChoiceRound } from '../../src/services/DiamondChoiceService';
import { verifyChoiceRound } from '../../src/utils/diamondChoiceMath';
import { pendingBonus } from '../../src/services/diamondBonusRecovery';
import { sealedChipPrize } from '../../src/utils/sealedChipPrize';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
const source = fixtures.receipts;
const plinko = source.plinko;
const crash = source.crash;
const crashRequest: BonusStart = {
  clubId: crash.club_id,
  game: 'crash',
  budget: {
    base: crash.bonus.base_diamonds,
    doubled: crash.bonus.added_diamonds > 0,
    denomination: 1,
  },
  commitId: crash.fairness.commit_id,
  serverSeedHash: crash.fairness.server_seed_hash,
  seed: crash.fairness.client_seed,
  autoCashoutCents: crash.auto_cashout_cents,
};
const openCrash = {
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
};
const request: BonusStart = {
  clubId: plinko.club_id,
  game: 'plinko',
  budget: {
    base: plinko.bonus.base_diamonds,
    doubled: plinko.bonus.added_diamonds > 0,
    denomination: plinko.diamonds_per_drop,
  },
  commitId: plinko.commit_id,
  serverSeedHash: plinko.server_seed_hash,
  seed: plinko.client_seed,
  tableVersion: plinko.table_version,
};
beforeEach(() => {
  sessionStorage.clear();
  rpc.mockReset();
});
describe('complete sealed bonus receipts', () => {
  it('rejects a Plinko path ending in a different slot even when its quoted multiplier matches', async () => {
    const altered = structuredClone(plinko);
    altered.drops[0].path_bits = 0;
    rpc.mockResolvedValueOnce({ data: altered, error: null });
    await expect(DiamondBonusService.start(request, 'player-a')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('player-a', request.clubId, 'plinko')).toEqual(request);
    rpc.mockResolvedValueOnce({ data: plinko, error: null });
    await expect(DiamondBonusService.start(request, 'player-a')).resolves.toEqual(plinko);
    expect(pendingBonus('player-a', request.clubId, 'plinko')).toBeNull();
  });
  it.each([
    ['missing result', undefined],
    ['boolean result', false],
    ['array result', []],
    ['refused result', { ...plinko, ok: false }],
    ['another club', { ...plinko, club_id: '00000000-0000-0000-0000-000000000099' }],
    ['another game', { ...plinko, game: 'mines' }],
  ])('rejects saved Plinko history with %s', async (_label, result) => {
    rpc.mockResolvedValueOnce({ data: { ok: true, result }, error: null });
    await expect(DiamondBonusService.latest(request.clubId, 'plinko')).rejects.toThrow(
      'Does Not Match'
    );
  });
  it('distinguishes an explicitly empty history from the saved result for this club and game', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, result: null }, error: null });
    await expect(DiamondBonusService.latest(request.clubId, 'plinko')).resolves.toBeNull();
    rpc.mockResolvedValueOnce({ data: { ok: true, result: plinko }, error: null });
    await expect(DiamondBonusService.latest(request.clubId, 'plinko')).resolves.toEqual(plinko);
    expect(rpc).toHaveBeenLastCalledWith('fn_diamond_bonus_latest', {
      p_club_id: request.clubId,
      p_game: 'plinko',
    });
  });
  it.each([
    [
      'an exposed open crash point',
      { ...openCrash, fairness: { ...openCrash.fairness, crash_cents: crash.outcome.crash_cents } },
    ],
    ['an open multiplier below the starting value', { ...openCrash, multiplier_now_cents: 99 }],
    [
      'an open multiplier above the accepted cap',
      { ...openCrash, multiplier_now_cents: crash.cap_cents + 1 },
    ],
    [
      'a missing revealed crash point',
      { ...crash, fairness: { ...crash.fairness, crash_cents: undefined } },
    ],
    [
      'a different revealed crash point',
      { ...crash, fairness: { ...crash.fairness, crash_cents: crash.outcome.crash_cents + 1 } },
    ],
    [
      'a fractional crash point',
      { ...crash, outcome: { ...crash.outcome, crash_cents: crash.outcome.crash_cents + 0.5 } },
    ],
    [
      'a cashout attached to a loss',
      {
        ...crash,
        status: 'crashed',
        outcome: { ...crash.outcome, status: 'crashed', payout_chips: 0 },
      },
    ],
  ])(
    'retains the Crash recovery request after %s and recovers the exact valid retry',
    async (_label, malformed) => {
      rpc.mockResolvedValueOnce({ data: malformed, error: null });
      await expect(DiamondBonusService.start(crashRequest, 'player-a')).rejects.toThrow(
        'Could Not Be Verified'
      );
      expect(pendingBonus('player-a', crash.club_id, 'crash')).toEqual(crashRequest);
      rpc.mockResolvedValueOnce({ data: crash, error: null });
      await expect(DiamondBonusService.start(crashRequest, 'player-a')).resolves.toEqual(crash);
      expect(pendingBonus('player-a', crash.club_id, 'crash')).toBeNull();
      expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    }
  );
  it('accepts sealed open Crash receipts and consistent zero-payout losses', () => {
    expect(() => validateBonusReceipt(crashRequest, openCrash)).not.toThrow();
    expect(() =>
      validateBonusReceipt(crashRequest, {
        ...crash,
        status: 'crashed',
        outcome: { ...crash.outcome, status: 'crashed', cashout_cents: null, payout_chips: 0 },
      })
    ).not.toThrow();
  });
  it.each(['plinko', 'crash', 'mines', 'crossing'] as const)(
    'rejects a substituted but well-formed %s commitment',
    (game) => {
      const original = source[game] as unknown as Record<string, unknown>;
      const fairness = original.fairness as Record<string, unknown> | undefined;
      const bet = Number(original.bet_diamonds);
      const input: BonusStart =
        game === 'plinko'
          ? request
          : {
              clubId: String(original.club_id),
              game,
              budget: { base: bet, doubled: false, denomination: 1 },
              commitId: String(original.commit_id ?? fairness?.commit_id),
              serverSeedHash: String(original.server_seed_hash ?? fairness?.server_seed_hash),
              seed: String(original.client_seed ?? fairness?.client_seed),
              ...(game === 'crash'
                ? { autoCashoutCents: Number(original.auto_cashout_cents) }
                : { mode: String(original.mode), maxSteps: Number(original.max_steps) }),
            };
      const raw = {
        ...original,
        bonus: original.bonus ?? {
          id: '00000000-0000-0000-0000-000000000004',
          base_diamonds: bet,
          added_diamonds: 0,
          total_diamonds: bet,
        },
      };
      expect(() => validateBonusReceipt(input, raw)).not.toThrow();
      const rewritten =
        game === 'crash'
          ? { ...raw, fairness: { ...fairness, server_seed_hash: 'f'.repeat(64) } }
          : {
              ...raw,
              server_seed_hash: 'f'.repeat(64),
              ...(original.proof
                ? { proof: { ...(original.proof as object), server_seed_hash: 'f'.repeat(64) } }
                : {}),
            };
      expect(() => validateBonusReceipt(input, rewritten)).toThrow();
    }
  );
  it('reads real candidate PostgreSQL receipts and verifies both choice outcomes and chip amounts', async () => {
    expect(parsePlinkoBonus(plinko).drops).toHaveLength(10);
    expect(() => validateBonusReceipt(request, plinko)).not.toThrow();
    for (const value of [source.mines, source.crossing])
      expect(await verifyChoiceRound(parseChoiceRound(value))).toBe(true);
    const crash = source.crash;
    expect(() =>
      validateBonusReceipt(
        {
          clubId: crash.club_id,
          game: 'crash',
          budget: {
            base: crash.bonus.base_diamonds,
            doubled: crash.bonus.added_diamonds > 0,
            denomination: 1,
          },
          commitId: crash.fairness.commit_id,
          serverSeedHash: crash.fairness.server_seed_hash,
          seed: crash.fairness.client_seed,
          autoCashoutCents: crash.auto_cashout_cents,
        },
        crash
      )
    ).not.toThrow();
  });
  it('keeps recovery through a malformed accepted receipt, then clears only the complete retry', async () => {
    const broken = structuredClone(plinko);
    broken.drops.pop();
    rpc.mockResolvedValueOnce({ data: broken, error: null });
    await expect(DiamondBonusService.start(request, 'player-a')).rejects.toThrow();
    expect(pendingBonus('player-a', request.clubId, 'plinko')).toEqual(request);
    rpc.mockResolvedValueOnce({ data: plinko, error: null });
    await expect(DiamondBonusService.start(request, 'player-a')).resolves.toEqual(plinko);
    expect(pendingBonus('player-a', request.clubId, 'plinko')).toBeNull();
  });
  it('rejects a substituted game, board, denomination, seed, total, or chip amount', () => {
    const changes = [
      { game: 'crash' },
      { table_version: plinko.table_version + 1 },
      { diamonds_per_drop: 100 },
      { client_seed: 'another' },
      { bet_diamonds: plinko.bet_diamonds + 1 },
      { payout_chips: plinko.payout_chips + 0.01 },
      { server_seed_hash: 'bad' },
      { server_seed_hash: 'f'.repeat(64) },
      { club_id: 'another' },
    ];
    for (const change of changes)
      expect(() => validateBonusReceipt(request, { ...plinko, ...change })).toThrow();
  });
  it('rejects a leaked open mine board and detects a rewritten settled prize or mine', async () => {
    expect(() => parseChoiceRound({ ...source.mines, status: 'open', payout_chips: 0 })).toThrow();
    const mine = parseChoiceRound(structuredClone(source.mines));
    mine.payout_chips += 0.01;
    expect(await verifyChoiceRound(mine)).toBe(false);
    const changed = parseChoiceRound(structuredClone(source.mines));
    changed.proof!.mine_cells[0] = (changed.proof!.mine_cells[0] + 1) % 25;
    expect(await verifyChoiceRound(changed)).toBe(false);
  });
  it('matches PostgreSQL cent rounding both up and down for a 25-diamond entry', async () => {
    expect(new Set(cents.map((v) => v.chips))).toEqual(new Set([0.27, 0.28]));
    for (const vector of cents)
      expect(
        await sealedChipPrize({
          serverSeed: 'a'.repeat(64),
          clientSeed: 'fractional',
          nonce: vector.nonce,
          betChips: 0.25,
          multiplierCents: 110,
          roundingStep: 110,
        })
      ).toBe(vector.chips);
  });
});

describe('earned wheel receipt identity', () => {
  const awardId = '00000000-0000-0000-0000-000000000021';
  const budget = {
    base: 200,
    doubled: true,
    denomination: 1,
    award: { id: awardId, entryDiamonds: 100, boostMultiplier: 2 as const },
  };
  const awardedCrash = {
    ...openCrash,
    award_id: awardId,
    bet_diamonds: 300,
    bet_chips: 3,
    bonus: {
      ...crash.bonus,
      base_diamonds: 200,
      added_diamonds: 100,
      total_diamonds: 300,
      entry_diamonds: 100,
      boost_multiplier: 2,
    },
  };
  it('redeems the saved award without sending a fresh base debit and retains an unknown result', async () => {
    const input = { ...crashRequest, budget };
    rpc.mockResolvedValueOnce({ error: new Error('Disconnected'), data: null });
    await expect(DiamondBonusService.start(input, 'player-a')).rejects.toThrow('Disconnected');
    expect(pendingBonus('player-a', input.clubId, 'crash')).toEqual(input);
    rpc.mockResolvedValueOnce({ error: null, data: awardedCrash });
    await expect(DiamondBonusService.start(input, 'player-a')).resolves.toEqual(awardedCrash);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
    expect(rpc.mock.calls[0][0]).toBe('fn_wheel_bonus_start');
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_award_id: awardId, p_double: true });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_base_diamonds');
    expect(pendingBonus('player-a', input.clubId, 'crash')).toBeNull();
  });
  it.each([
    { award_id: '00000000-0000-0000-0000-000000000022' },
    { award_id: undefined },
    { bonus: { ...awardedCrash.bonus, added_diamonds: 200 } },
    { bonus: { ...awardedCrash.bonus, entry_diamonds: 200 } },
    { bonus: { ...awardedCrash.bonus, boost_multiplier: 1 } },
  ])('keeps the exact pending identity after a substituted award receipt', async (change) => {
    const input = { ...crashRequest, budget };
    rpc.mockResolvedValueOnce({ error: null, data: { ...awardedCrash, ...change } });
    await expect(DiamondBonusService.start(input, 'player-a')).rejects.toThrow(
      'Could Not Be Verified'
    );
    expect(pendingBonus('player-a', input.clubId, 'crash')).toEqual(input);
  });
  it('accepts maximum upgraded Plinko funding but does not loosen legacy or incomplete receipts', () => {
    const drops = Array.from({ length: 75 }, (_, index) => ({ ...plinko.drops[0], index }));
    const receipt = {
      ...plinko,
      award_id: awardId,
      bet_diamonds: 7500,
      diamonds_per_drop: 100,
      drops,
      payout_chips: drops.reduce((sum, ball) => sum + Math.round(ball.payout_chips * 100), 0) / 100,
      bonus: {
        ...plinko.bonus,
        base_diamonds: 5000,
        added_diamonds: 2500,
        total_diamonds: 7500,
        entry_diamonds: 2500,
        boost_multiplier: 2,
      },
    };
    expect(parsePlinkoBonus(receipt).drops).toHaveLength(75);
    expect(() => parsePlinkoBonus({ ...receipt, award_id: undefined })).toThrow();
    expect(() =>
      parsePlinkoBonus({ ...receipt, bonus: { ...receipt.bonus, boost_multiplier: 1 } })
    ).toThrow();
    expect(() =>
      parsePlinkoBonus({ ...receipt, bonus: { ...receipt.bonus, entry_diamonds: '2500' } })
    ).toThrow();
  });
  it('keeps maximum upgraded Choice action/history receipts identity bound', () => {
    const receipt = {
      ...source.mines,
      award_id: awardId,
      bet_diamonds: 7500,
      bet_chips: 75,
      bonus: {
        id: source.mines.id,
        base_diamonds: 5000,
        added_diamonds: 2500,
        total_diamonds: 7500,
        entry_diamonds: 2500,
        boost_multiplier: 2,
      },
    };
    expect(parseChoiceRound(receipt).bet_diamonds).toBe(7500);
    expect(() => parseChoiceRound({ ...receipt, award_id: undefined })).toThrow();
    expect(() =>
      parseChoiceRound({ ...receipt, bonus: { ...receipt.bonus, added_diamonds: 5000 } })
    ).toThrow();
  });
});
