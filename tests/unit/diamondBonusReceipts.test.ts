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
const request: BonusStart = {
  clubId: plinko.club_id,
  game: 'plinko',
  budget: {
    base: plinko.bonus.base_diamonds,
    doubled: plinko.bonus.added_diamonds > 0,
    denomination: plinko.diamonds_per_drop,
  },
  commitId: plinko.commit_id,
  seed: plinko.client_seed,
  tableVersion: plinko.table_version,
};
beforeEach(() => {
  sessionStorage.clear();
  rpc.mockReset();
});
describe('complete sealed bonus receipts', () => {
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
