import { rememberBonus, clearPendingBonus } from './diamondBonusRecovery';
import { supabase } from '../lib/supabase';
import {
  bonusAdded,
  bonusTotal,
  validBonusBudget,
  earnedReceiptBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';
import { validSpinAmount, PLINKO_DROPS, plinkoDenomination } from '../utils/bonusGameBudget';
import { parseChoiceRound } from './DiamondChoiceService';
import { validateCrashSettlement } from '../utils/crashReceipt';
import { diamondBonusMinimum, plinkoTableVersion } from '../utils/diamondBonusPayout';

export type BonusGame = 'plinko' | 'crash' | 'crossing' | 'mines';
/** The server said no and charged nothing. `ticketGone` marks the one refusal
 * the page settles by itself: the sealed ticket can no longer open a round
 * (missing, expired, or used by another round), so a fresh ticket is dealt and
 * the same wager is sent again without a human in the loop. */
export class BonusRefusal extends Error {
  constructor(
    message: string,
    readonly ticketGone = false
  ) {
    super(message);
  }
}
export interface BonusStart {
  clubId: string;
  game: BonusGame;
  budget: BonusBudget;
  commitId: string;
  /** Absent only on a pending request saved by an older client. */
  serverSeedHash?: string;
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
  /** A Super batch returns at least half its doubled stake, the spin entry. */
  minimum_payout_chips?: number;
  payout_version?: 1 | 3;
  server_seed_hash: string;
  server_seed: string;
  client_seed: string;
  nonce: number;
  commit_id: string;
  award_id?: string;
  bonus: {
    id: string;
    base_diamonds: number;
    added_diamonds: number;
    total_diamonds: number;
    entry_diamonds?: number;
    boost_multiplier?: number;
  };
}
export function parsePlinkoBonus(value: unknown): PlinkoBonus {
  const v = value as PlinkoBonus;
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const cents = (n: unknown) =>
    finite(n) && Math.abs(Number(n) * 100 - Math.round(Number(n) * 100)) < 1e-8;
  const id = (v: unknown) =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const slotForPath = (bits: number) => {
    let slot = 0;
    for (let row = 0; row < 16; row++) slot += (bits >> row) & 1;
    return slot;
  };
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
    (v.award_id !== undefined
      ? !earnedReceiptBudget(v as unknown as Record<string, unknown>)
      : !validSpinAmount(v.bonus.base_diamonds) ||
        ![0, v.bonus.base_diamonds].includes(v.bonus.added_diamonds)) ||
    v.bonus.total_diamonds !== v.bet_diamonds ||
    v.bonus.base_diamonds + v.bonus.added_diamonds !== v.bet_diamonds ||
    !Number.isSafeInteger(v.bet_diamonds) ||
    v.bet_diamonds < 25 ||
    v.bet_diamonds > (v.award_id ? 7500 : 5000) ||
    !Number.isSafeInteger(v.diamonds_per_drop) ||
    v.diamonds_per_drop < 1 ||
    v.bet_diamonds % v.diamonds_per_drop !== 0 ||
    !Array.isArray(v.drops) ||
    v.drops.length !== v.bet_diamonds / v.diamonds_per_drop ||
    // A batch sealed since ten drops became the one setting (it carries
    // payout_version) is ten drops of a tenth of the entry. Older receipts keep
    // the drop value they were dealt.
    (v.payout_version !== undefined &&
      (v.drops.length !== PLINKO_DROPS || v.diamonds_per_drop !== plinkoDenomination(v.bet_diamonds))) ||
    !Array.isArray(v.multipliers_cents) ||
    v.multipliers_cents.length !== 17 ||
    !v.multipliers_cents.every((m) => Number.isSafeInteger(m) && m >= 0) ||
    !cents(v.payout_chips) ||
    !validPlinkoMinimum(v) ||
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
        ball.slot !== slotForPath(ball.path_bits) ||
        ball.multiplier_cents !== v.multipliers_cents[ball.slot] ||
        !cents(ball.payout_chips)
    ) ||
    // The batch pays its drops, or the Super guarantee when the drops fall short.
    Math.max(
      v.drops.reduce((sum, ball) => sum + Math.round(ball.payout_chips * 100), 0),
      Math.round((v.minimum_payout_chips ?? 0) * 100)
    ) !== Math.round(v.payout_chips * 100)
  ) {
    throw new Error('The Plinko Bonus Could Not Be Verified');
  }
  return v;
}

/** A batch settled before the Super guarantee carries no floor; a Super batch
 * (payout_version 3) carries half its stake, computed from the funded diamonds
 * and the bridge rate exactly as the server did. */
function validPlinkoMinimum(v: PlinkoBonus) {
  const floor = v.minimum_payout_chips;
  const version = v.payout_version;
  if (floor === undefined && version === undefined) return true;
  if (version === 1) return floor === 0;
  if (version !== 3 || typeof floor !== 'number') return false;
  if (!Number.isSafeInteger(v.bet_diamonds) || !Number.isSafeInteger(v.diamonds_per_chip))
    return false;
  try {
    return floor === diamondBonusMinimum(v.bet_diamonds / v.diamonds_per_chip, 2);
  } catch {
    return false;
  }
}

export const DiamondBonusService = {
  async start(input: BonusStart, userId: string): Promise<unknown> {
    if (
      !input.budget ||
      typeof input.budget.doubled !== 'boolean' ||
      !validBonusBudget(input.budget)
    )
      throw new BonusRefusal('Choose 25 To 2,500 Diamonds');
    if (!userId) throw new BonusRefusal('Sign In To Play');
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (typeof input.seed !== 'string' || !input.seed.trim().length || input.seed.length > 64)
      throw new BonusRefusal('Enter A Seed With 1 To 64 Characters');
    if (
      !uuid.test(input.clubId) ||
      !uuid.test(input.commitId) ||
      !['plinko', 'crash', 'crossing', 'mines'].includes(input.game) ||
      // The server owns the ten-drop rule; a saved request from before it is sent as
      // it was, so a completed game replays its receipt instead of being refused here.
      (input.game === 'plinko' &&
        (!Number.isSafeInteger(input.budget.denomination) ||
          input.budget.denomination < 1 ||
          bonusTotal(input.budget) % input.budget.denomination !== 0)) ||
      (input.serverSeedHash !== undefined && !/^[a-f0-9]{64}$/.test(input.serverSeedHash))
    )
      throw new BonusRefusal('The Bonus Settings Could Not Be Verified');
    rememberBonus(userId, input);
    const { data, error } = await supabase.rpc(
      (input.budget.award ? 'fn_wheel_bonus_start' : 'fn_diamond_bonus_start') as never,
      {
        ...(input.budget.award
          ? { p_award_id: input.budget.award.id }
          : {
              p_club_id: input.clubId,
              p_game: input.game,
              p_base_diamonds: input.budget.base,
            }),
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
      throw new BonusRefusal(result.error, result.ticket === 'gone');
    }
    const bonus = result?.bonus as PlinkoBonus['bonus'] | undefined;
    const fairness = result?.fairness as Record<string, unknown> | undefined;
    if (
      !bonus ||
      bonus.base_diamonds !== input.budget.base ||
      bonus.added_diamonds !== bonusAdded(input.budget) ||
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
    const value = data as { ok: boolean; result: Record<string, unknown> | null };
    if (value?.ok !== true) throw new Error('Your Bonus Could Not Be Checked');
    if (
      value.result !== null &&
      (!value.result ||
        value.result.ok !== true ||
        value.result.club_id !== clubId ||
        value.result.game !== game)
    )
      throw new Error('Your Saved Bonus Does Not Match This Game');
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
  const fairness = raw.fairness as Record<string, unknown> | undefined;
  if (
    (input.budget.award
      ? raw.award_id !== input.budget.award.id ||
        !earnedReceiptBudget(raw) ||
        b?.entry_diamonds !== input.budget.award.entryDiamonds ||
        b?.boost_multiplier !== input.budget.award.boostMultiplier
      : raw.award_id !== undefined) ||
    raw.ok !== true ||
    raw.game !== input.game ||
    raw.club_id !== input.clubId ||
    !id(b?.id) ||
    b?.base_diamonds !== input.budget.base ||
    b?.added_diamonds !== bonusAdded(input.budget) ||
    b?.total_diamonds !== bonusTotal(input.budget) ||
    raw.bet_diamonds !== bonusTotal(input.budget) ||
    (input.serverSeedHash !== undefined &&
      (!/^[a-f0-9]{64}$/.test(input.serverSeedHash) ||
        (input.game === 'crash' ? fairness?.server_seed_hash : raw.server_seed_hash) !==
          input.serverSeedHash))
  )
    fail();
  if (input.game === 'plinko') {
    const result = parsePlinkoBonus(raw);
    const boost = input.budget.award?.boostMultiplier ?? 1;
    // A receipt sealed since the one-table rule (it carries payout_version) must
    // name the table the stake kind owns, and a Super batch its guarantee. A
    // receipt sealed before it keeps the table it was dealt.
    const sealedWithRule = result.payout_version !== undefined;
    if (
      result.table_version !== input.tableVersion ||
      (sealedWithRule && result.table_version !== plinkoTableVersion(boost)) ||
      (sealedWithRule &&
        (boost === 2
          ? result.payout_version !== 3 ||
            result.minimum_payout_chips !==
              diamondBonusMinimum(bonusTotal(input.budget) / result.diamonds_per_chip, 2)
          : result.payout_version !== 1)) ||
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
    // Start, replay and cashout must agree before a saved wager can be cleared.
    validateCrashSettlement(raw, raw.round_id as string);
  }
}
