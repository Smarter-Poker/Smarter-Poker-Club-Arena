import { rememberBonus, clearPendingBonus } from './diamondBonusRecovery';
import { supabase } from '../lib/supabase';
import { bonusTotal, type BonusBudget } from '../utils/bonusGameBudget';
import { validSpinAmount, PLINKO_DIAMONDS_PER_DROP } from '../utils/bonusGameBudget';
import { parseChoiceRound } from './DiamondChoiceService';

export type BonusGame = 'plinko' | 'crash' | 'crossing' | 'mines';
export class BonusRefusal extends Error {}
export interface BonusStart {
  clubId: string;
  game: BonusGame;
  budget: BonusBudget;
  commitId: string;
  seed: string;
  mode?: string;
  tableVersion?: number;
  autoCashoutCents?: number | null;
  maxSteps?: number;
}
export interface PlinkoBall {
  index: number;
  path_bits: number;
  slot: number;
  multiplier_cents: number;
  payout_chips: number;
}
export interface PlinkoBonus {
  ok: true;
  id: string;
  game: 'plinko';
  club_id: string;
  bet_diamonds: number;
  diamonds_per_drop: number;
  diamonds_per_chip: number;
  table_version: number;
  table_name: string;
  multipliers_cents: number[];
  drops: PlinkoBall[];
  payout_chips: number;
  server_seed_hash: string;
  server_seed: string;
  client_seed: string;
  nonce: number;
  commit_id: string;
  bonus: { id: string; base_diamonds: number; added_diamonds: number; total_diamonds: number };
}
export function parsePlinkoBonus(value: unknown): PlinkoBonus {
  const v = value as PlinkoBonus;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const cents = (n: unknown) =>
    finite(n) && Math.abs(Number(n) * 100 - Math.round(Number(n) * 100)) < 1e-8;
  const id = (v: unknown) =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  if (
    !v ||
    v.ok !== true ||
    v.game !== 'plinko' ||
    !id(v.id) ||
    !id(v.club_id) ||
    !id(v.commit_id) ||
    typeof v.client_seed !== 'string' ||
    !v.client_seed.length ||
    v.client_seed.length > 64 ||
    !Number.isSafeInteger(v.table_version) ||
    v.table_version < 1 ||
    typeof v.table_name !== 'string' ||
    !v.table_name.length ||
    !v.bonus ||
    !id(v.bonus.id) ||
    v.bonus.id !== v.id ||
    !validSpinAmount(v.bonus.base_diamonds) ||
    ![0, v.bonus.base_diamonds].includes(v.bonus.added_diamonds) ||
    v.bonus.total_diamonds !== v.bet_diamonds ||
    v.bonus.base_diamonds + v.bonus.added_diamonds !== v.bet_diamonds ||
    !Number.isSafeInteger(v.bet_diamonds) ||
    v.bet_diamonds < 25 ||
    v.bet_diamonds > 5000 ||
    !PLINKO_DIAMONDS_PER_DROP.includes(v.diamonds_per_drop as 1) ||
    v.bet_diamonds % v.diamonds_per_drop !== 0 ||
    !Array.isArray(v.drops) ||
    v.drops.length !== v.bet_diamonds / v.diamonds_per_drop ||
    !Array.isArray(v.multipliers_cents) ||
    v.multipliers_cents.length !== 17 ||
    !v.multipliers_cents.every((m) => Number.isSafeInteger(m) && m >= 0) ||
    !cents(v.payout_chips) ||
    !Number.isSafeInteger(v.nonce) ||
    v.nonce < 1 ||
    !/^[a-f0-9]{64}$/.test(v.server_seed_hash) ||
    !/^[a-f0-9]{64}$/.test(v.server_seed) ||
    !Number.isSafeInteger(v.diamonds_per_chip) ||
    v.diamonds_per_chip <= 0 ||
    v.drops.some(
      (ball, index) =>
        ball.index !== index ||
        !Number.isInteger(ball.path_bits) ||
        ball.path_bits < 0 ||
        ball.path_bits > 65535 ||
        !Number.isInteger(ball.slot) ||
        ball.slot < 0 ||
        ball.slot > 16 ||
        ball.multiplier_cents !== v.multipliers_cents[ball.slot] ||
        !cents(ball.payout_chips)
    ) ||
    Math.abs(
      v.drops.reduce((sum, ball) => sum + Math.round(ball.payout_chips * 100), 0) -
        Math.round(v.payout_chips * 100)
    ) > 0
  ) {
    throw new Error('The Plinko Bonus Could Not Be Verified');
  }
  return v;
}

export const DiamondBonusService = {
  async start(input: BonusStart, userId: string): Promise<unknown> {
    if (
      !input.budget ||
      typeof input.budget.doubled !== 'boolean' ||
      !validSpinAmount(input.budget.base)
    )
      throw new BonusRefusal('Choose 25 To 2,500 Diamonds');
    if (!userId) throw new BonusRefusal('Sign In To Play');
    rememberBonus(userId, input);
    const { data, error } = await supabase.rpc(
      'fn_diamond_bonus_start' as never,
      {
        p_club_id: input.clubId,
        p_game: input.game,
        p_base_diamonds: input.budget.base,
        p_double: input.budget.doubled,
        p_commit_id: input.commitId,
        p_client_seed: input.seed,
        p_mode: input.mode ?? null,
        p_denom: input.game === 'plinko' ? input.budget.denomination : null,
        p_table_version: input.tableVersion ?? null,
        p_auto_cashout_cents: input.autoCashoutCents ?? null,
        p_max_steps: input.maxSteps ?? null,
      } as never
    );
    if (error) throw error;
    const result = data as Record<string, unknown> | null;
    if (result?.ok === false && typeof result.error === 'string') {
      clearPendingBonus(userId, input);
      throw new BonusRefusal(result.error);
    }
    const bonus = result?.bonus as PlinkoBonus['bonus'] | undefined;
    const fairness = result?.fairness as Record<string, unknown> | undefined;
    if (
      !bonus ||
      bonus.base_diamonds !== input.budget.base ||
      bonus.added_diamonds !== (input.budget.doubled ? input.budget.base : 0) ||
      bonus.total_diamonds !== bonusTotal(input.budget) ||
      (result?.client_seed ?? fairness?.client_seed) !== input.seed ||
      result?.ok !== true ||
      result.club_id !== input.clubId ||
      (result.commit_id !== input.commitId &&
        (result.fairness as Record<string, unknown> | undefined)?.commit_id !== input.commitId) ||
      result.bet_diamonds !== bonusTotal(input.budget)
    ) {
      throw new Error('The Bonus Response Could Not Be Verified');
    }
    validateBonusReceipt(input, result);
    clearPendingBonus(userId, input);
    return data;
  },
  async latest(clubId: string, game: BonusGame): Promise<unknown | null> {
    const { data, error } = await supabase.rpc(
      'fn_diamond_bonus_latest' as never,
      { p_club_id: clubId, p_game: game } as never
    );
    if (error) throw error;
    const value = data as { ok: boolean; result: unknown };
    if (value?.ok !== true) throw new Error('Your Bonus Could Not Be Checked');
    return value.result;
  },
};

/** Keep the saved request until the complete receipt, including game settings, is valid. */
export function validateBonusReceipt(input: BonusStart, raw: Record<string, unknown>) {
  const id = (value: unknown) =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  const fail = () => {
    throw new Error('The Bonus Receipt Could Not Be Verified');
  };
  const b = raw.bonus as PlinkoBonus['bonus'] | undefined;
  if (
    raw.ok !== true ||
    raw.game !== input.game ||
    raw.club_id !== input.clubId ||
    !id(b?.id) ||
    b?.base_diamonds !== input.budget.base ||
    b?.added_diamonds !== (input.budget.doubled ? input.budget.base : 0) ||
    b?.total_diamonds !== bonusTotal(input.budget) ||
    raw.bet_diamonds !== bonusTotal(input.budget)
  )
    fail();
  if (input.game === 'plinko') {
    const result = parsePlinkoBonus(raw);
    if (
      result.table_version !== input.tableVersion ||
      result.diamonds_per_drop !== input.budget.denomination ||
      result.commit_id !== input.commitId ||
      result.client_seed !== input.seed
    )
      fail();
  } else if (input.game === 'mines' || input.game === 'crossing') {
    const result = parseChoiceRound(raw);
    if (
      result.mode !== input.mode ||
      result.max_steps !== input.maxSteps ||
      result.commit_id !== input.commitId ||
      result.client_seed !== input.seed
    )
      fail();
  } else {
    const f = raw.fairness as Record<string, unknown> | undefined;
    const o = raw.outcome as Record<string, unknown> | null;
    if (
      !id(raw.round_id) ||
      !id(raw.host_id) ||
      !f ||
      f.commit_id !== input.commitId ||
      f.client_seed !== input.seed ||
      typeof f.server_seed_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.server_seed_hash) ||
      !Number.isSafeInteger(f.nonce) ||
      Number(f.nonce) < 1 ||
      !['open', 'cashed', 'crashed'].includes(String(raw.status)) ||
      !Number.isSafeInteger(raw.diamonds_per_chip) ||
      Number(raw.diamonds_per_chip) < 1 ||
      !finite(raw.bet_chips) ||
      Math.abs(raw.bet_chips - bonusTotal(input.budget) / Number(raw.diamonds_per_chip)) > 1e-8 ||
      !Number.isSafeInteger(raw.cap_cents) ||
      Number(raw.cap_cents) < 101 ||
      !finite(raw.growth_k) ||
      raw.growth_k <= 0 ||
      !finite(raw.elapsed_ms) ||
      raw.elapsed_ms < 0 ||
      typeof raw.started_at !== 'string' ||
      !Number.isFinite(Date.parse(raw.started_at)) ||
      typeof raw.server_now !== 'string' ||
      !Number.isFinite(Date.parse(raw.server_now)) ||
      raw.auto_cashout_cents !== (input.autoCashoutCents ?? null)
    )
      fail();
    if (raw.status === 'open') {
      if (
        o !== null ||
        f?.server_seed !== undefined ||
        f?.roll !== undefined ||
        !Number.isSafeInteger(raw.multiplier_now_cents)
      )
        fail();
    } else if (
      !o ||
      o.status !== raw.status ||
      !finite(o.payout_chips) ||
      o.payout_chips < 0 ||
      Math.abs(o.payout_chips * 100 - Math.round(o.payout_chips * 100)) > 1e-8 ||
      !finite(o.crash_cents) ||
      o.crash_cents < 100 ||
      typeof f?.server_seed !== 'string' ||
      !/^[a-f0-9]{64}$/.test(f.server_seed) ||
      !Number.isSafeInteger(f.roll) ||
      Number(f.roll) < 0 ||
      Number(f.roll) >= 281474976710656 ||
      (raw.status === 'crashed' && o.payout_chips !== 0) ||
      (raw.status === 'cashed' &&
        (!Number.isSafeInteger(o.cashout_cents) ||
          Number(o.cashout_cents) < 101 ||
          Number(o.cashout_cents) > Math.min(Number(raw.cap_cents), o.crash_cents)))
    )
      fail();
  }
}
