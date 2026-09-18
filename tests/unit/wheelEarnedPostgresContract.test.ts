import { beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from '../fixtures/diamond-spins/wheel-earned-postgres-receipts.json';
import upgradeFixture from '../fixtures/diamond-spins/wheel-v3-postgres-receipts.json';
import {
  WheelBonusEntryService,
  awardBudget,
  type EarnedGameAward,
} from '../../src/services/WheelBonusEntryService';
import {
  DiamondBonusService,
  parsePlinkoBonus,
  type BonusGame,
  type BonusStart,
} from '../../src/services/DiamondBonusService';
import DiamondGamesService, { normaliseCrash } from '../../src/services/DiamondGamesService';
import { DiamondChoiceService, parseChoiceRound } from '../../src/services/DiamondChoiceService';
import { pendingBonus } from '../../src/services/diamondBonusRecovery';
import { bonusTotal, bonusWalletDebit } from '../../src/utils/bonusGameBudget';
import { verifyChoiceRound } from '../../src/utils/diamondChoiceMath';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
type Receipt = {
  kind: string;
  game: BonusGame;
  stake: number;
  double: boolean;
  value: Record<string, unknown>;
};
const versions = [
  { version: 2, records: fixture.records as unknown as Receipt[] },
  {
    version: 3,
    records: upgradeFixture.records.filter((r) => 'game' in r) as unknown as Receipt[],
  },
];
const records = versions.flatMap(({ version, records: rows }) =>
  rows.map((r) => ({ ...r, version }))
);
const starts = records.filter((r) => r.kind === 'start');
const account = 'fixture-player';
function request(receipt: Receipt): BonusStart {
  const raw = receipt.value;
  const state = records.find(
    (r) => r.kind === 'state' && (r.value.award as EarnedGameAward).id === raw.award_id
  )!;
  const fairness = (raw.fairness ?? raw) as Record<string, unknown>;
  return {
    clubId: raw.club_id as string,
    game: receipt.game,
    budget: awardBudget(state.value.award as EarnedGameAward, {
      base: 100,
      doubled: receipt.double,
      denomination: (raw.diamonds_per_drop as number) ?? 1,
    }),
    commitId: fairness.commit_id as string,
    serverSeedHash: fairness.server_seed_hash as string,
    seed: fairness.client_seed as string,
    ...(receipt.game === 'plinko'
      ? { tableVersion: raw.table_version as number }
      : receipt.game === 'crash'
        ? { autoCashoutCents: raw.auto_cashout_cents as number | null }
        : { mode: raw.mode as string, maxSteps: raw.max_steps as number }),
  };
}

beforeEach(() => {
  rpc.mockReset();
  sessionStorage.clear();
});

describe('actual isolated PostgreSQL earned-game contract', () => {
  it.each(versions)(
    'retains normal, doubled, and maximum upgraded examples from wheel v$version',
    ({ records: rows }) => {
      for (const game of ['plinko', 'crash', 'crossing', 'mines']) {
        expect(
          rows.filter((r) => r.kind === 'start' && r.game === game).map((r) => r.value.bet_diamonds)
        ).toEqual([100, 200, 7500]);
      }
      expect(rows).toHaveLength(48);
    }
  );
  it.each(
    records.map((r, index) => ({
      ...r,
      label: `${index}: wheel v${r.version}, ${r.game} ${r.kind}, stake ${r.stake}, double ${r.double}`,
    }))
  )('$label', async (receipt) => {
    const raw = receipt.value;
    rpc.mockResolvedValue({ data: structuredClone(raw), error: null });
    if (receipt.kind === 'state') {
      const award = raw.award as EarnedGameAward;
      const start = starts.find((r) => r.value.award_id === award.id)!;
      const input = request(start);
      const state = await WheelBonusEntryService.state(
        award.club_id,
        receipt.game,
        receipt.double,
        input.mode,
        award.id
      );
      expect(state.award).toEqual(award);
      expect(state.gameState?.available).toBe(true);
      expect(state.gameState?.bets).toEqual((raw.game_state as Record<string, unknown>).bets);
      if (state.gameState && 'prizes' in state.gameState) {
        expect(state.gameState.prizes).toEqual((raw.game_state as Record<string, unknown>).prizes);
        expect(state.gameState.max_steps).toBe(
          (raw.game_state as Record<string, unknown>).max_steps
        );
      }
      expect(bonusTotal(input.budget)).toBe(award.bet_diamonds);
      expect(bonusWalletDebit(input.budget)).toBe(receipt.double ? receipt.stake : 0);
      expect(rpc).toHaveBeenCalledWith('fn_wheel_bonus_state', {
        p_club_id: award.club_id,
        p_game: receipt.game,
        p_double: receipt.double,
        p_mode: input.mode ?? null,
        p_award_id: award.id,
      });
      return;
    }
    const start = starts.find((r) => r.value.award_id === raw.award_id)!;
    const input = request(start);
    if (receipt.kind === 'start' || receipt.kind === 'replay') {
      if (receipt.kind === 'replay') {
        rpc.mockRejectedValueOnce(new Error('Connection Interrupted'));
        await expect(DiamondBonusService.start(input, account)).rejects.toThrow(
          'Connection Interrupted'
        );
        expect(pendingBonus(account, input.clubId, receipt.game)).toEqual(input);
      }
      await expect(DiamondBonusService.start(input, account)).resolves.toEqual(raw);
      expect(pendingBonus(account, input.clubId, receipt.game)).toBeNull();
      expect(rpc).toHaveBeenLastCalledWith('fn_wheel_bonus_start', {
        p_award_id: raw.award_id,
        p_commit_id: input.commitId,
        p_client_seed: input.seed,
        p_double: receipt.double,
        p_mode: input.mode ?? null,
        p_denom: receipt.game === 'plinko' ? input.budget.denomination : null,
        p_table_version: input.tableVersion ?? null,
        p_auto_cashout_cents: input.autoCashoutCents ?? null,
        p_max_steps: input.maxSteps ?? null,
      });
      return;
    }
    if (receipt.game === 'plinko') {
      const result = parsePlinkoBonus(raw);
      expect(result.award_id).toBe(input.budget.award!.id);
      expect(result.drops.length * result.diamonds_per_drop).toBe(bonusTotal(input.budget));
    } else if (receipt.game === 'crash') {
      const open = normaliseCrash(start.value);
      const result = await DiamondGamesService.crashSettle(open.round_id, true, open, 101);
      expect(result.status).toBe(raw.status);
      expect(result.bet_diamonds).toBe(bonusTotal(input.budget));
      expect(rpc).toHaveBeenCalledWith('fn_crash_cashout', {
        p_round_id: open.round_id,
        p_multiplier_cents: 101,
      });
    } else {
      const open = parseChoiceRound(start.value);
      const result = await DiamondChoiceService.act(open, 'pick', 0);
      expect(result).toEqual(raw);
      expect(await verifyChoiceRound(result)).toBe(true);
    }
  });
});
