import { rememberBonus, clearPendingBonus, PriorBonusPending } from './diamondBonusRecovery';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import {
  bonusAdded,
  bonusTotal,
  validBonusBudget,
  earnedReceiptBudget,
  type BonusBudget,
} from '../utils/bonusGameBudget';
import { validSpinAmount, PLINKO_MAX_DROPS, PLINKO_MIN_DROPS } from '../utils/bonusGameBudget';
import { parseChoiceRound } from './DiamondChoiceService';
import { validateCrashSettlement } from '../utils/crashReceipt';
import {
  BONUS_PAYOUT_VERSION,
  diamondBonusFloor,
  diamondBonusMinimum,
  plinkoTableForFloor,
  plinkoTableVersion,
  validBonusMinimum,
} from '../utils/diamondBonusPayout';
import { crashCashoutFloorCents } from '../utils/diamondGamesFairness';

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

/**
 * AN ERROR THE DATABASE ANSWERED IS AN ANSWER (2026-09-22). The same rule the
 * wheel's spin doors follow (DiamondWheelService, spinErrorKind), so the two
 * services agree on every error.
 *
 * Both start functions take the ticket's lock and answer a request whose ticket
 * this request already used before they can touch an entry or a chip:
 * fn_diamond_bonus_start reads the entry that carries the ticket, and
 * fn_wheel_bonus_start a redeemed award, ahead of the dead-ticket refusal
 * (pinned by tests/a-saved-round-settles-itself.law.test.ts). So a request
 * whose answer was lost is sent again safely: if an earlier send committed, the
 * next one is answered by that round's receipt, never by a second round.
 *
 * An error carrying a SQLSTATE says what a lost answer cannot. The database ran
 * THIS execution and rolled it back, and there was no committed round behind
 * it: an earlier committed send of the same request would have been answered
 * by the replay branch with its receipt, not by an error. Nothing was charged.
 * The award pages used to treat it as unconfirmed and send it again every eight
 * seconds for as long as they stayed open, with the exit guard holding the
 * player on them. If the server does hold a round, the page's own state read
 * shows it.
 *
 *  - A SQLSTATE that passes (a serialization failure, a deadlock, a lock not
 *    available in time, a statement timeout), and PostgREST saying it could not
 *    reach the database at all (PGRST000-003, where nothing ran), leave the
 *    saved request for the page to send again, until that request has met such
 *    an answer BONUS_SENDS_PER_REQUEST times. That answer is a refusal.
 *  - Any other SQLSTATE, and any other PostgREST code (nothing ran), is a
 *    refusal at once: it is the answer every later send would get.
 *  - No code at all (the network, a gateway page) says nothing about whether
 *    the round opened, so the saved request stays and the page keeps sending it
 *    until it hears back.
 */
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '57014']);
export const BONUS_SENDS_PER_REQUEST = 3;
/** What the player reads when the database answered a start with an error. */
export const BONUS_NOT_TAKEN = 'The Game Could Not Take That Round';
/** What the player reads when this browser could not save a wager, so never sent it. */
export const BONUS_NOT_SAVED = 'This Browser Could Not Save Your Round. Nothing Was Charged.';
/** What the page says once it stops sending a request whose answers it cannot verify. */
export const BONUS_SAVED = 'Your Round Is Saved';
/** Sends of each request that met a passing error, while it may still be sent. */
const passingSends = new Map<string, number>();
/** Answers for each request that this browser could not verify. */
const unreadableSends = new Map<string, number>();
const forgetSends = (commitId: string) => {
  passingSends.delete(commitId);
  unreadableSends.delete(commitId);
};

export type BonusErrorKind = 'refused' | 'transient' | 'unknown';

/** What an error from a start RPC says about the round. */
export function bonusErrorKind(error: unknown): BonusErrorKind {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';
  if (code.startsWith('PGRST')) return /^PGRST00[0-3]$/.test(code) ? 'transient' : 'refused';
  if (/^[0-9A-Z]{5}$/.test(code)) return TRANSIENT_SQLSTATES.has(code) ? 'transient' : 'refused';
  return 'unknown';
}

/**
 * The server answered the start and this browser cannot verify what it said.
 * Unlike a lost answer, money may have moved, so the saved request is kept;
 * unlike a lost answer, the same bytes will not verify on a later send. `final`
 * is set once this request has had BONUS_SENDS_PER_REQUEST such answers: the
 * page then stops sending it, lets the player go, reads the game again (which
 * shows any open round) and says the round is saved. The next visit sends it
 * again.
 */
export class BonusUnreadable extends Error {
  constructor(
    cause: unknown,
    readonly final: boolean
  ) {
    super(cause instanceof Error ? cause.message : 'The Bonus Response Could Not Be Verified');
    this.name = 'BonusUnreadable';
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
  /** The chips this batch pays whatever the drops do: half the stake, or for a
   *  Super award with the add-on what the player paid. */
  minimum_payout_chips?: number;
  /** 1: no floor (historical). 3: the Super half. 4: the paid floor. */
  payout_version?: 1 | 3 | 4;
  /** Contract 4: the spin entry plus the Double Diamonds add-on, in diamonds. */
  paid_diamonds?: number;
  /** Contract 4: the drops this batch played, the player's own split of the stake. */
  drop_count?: number;
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
    // Drops x value = stake, whatever value the player chose (Dan 2026-09-21,
    // R6). A batch sealed under the current rule (it carries payout_version)
    // plays between PLINKO_MIN_DROPS and PLINKO_MAX_DROPS drops; older receipts
    // keep the count they were dealt.
    v.drops.length !== v.bet_diamonds / v.diamonds_per_drop ||
    (v.payout_version !== undefined &&
      (v.drops.length < PLINKO_MIN_DROPS || v.drops.length > PLINKO_MAX_DROPS)) ||
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
 * (payout_version 3) carries half its stake; a contract-4 batch carries the
 * floor fn_diamond_bonus_floor seals - half the stake, or for a Super award the
 * greater of that and what the player PAID. Every one is recomputed from the
 * funded diamonds and the bridge rate exactly as the server did, never trusted. */
function validPlinkoMinimum(v: PlinkoBonus) {
  const floor = v.minimum_payout_chips;
  const version = v.payout_version;
  if (floor === undefined && version === undefined) return true;
  if (version === 1) return floor === 0;
  if (typeof floor !== 'number') return false;
  if (!Number.isSafeInteger(v.bet_diamonds) || !Number.isSafeInteger(v.diamonds_per_chip))
    return false;
  if (version === BONUS_PAYOUT_VERSION) {
    // The batch names the diamonds it was paid for; the shared rule checks them.
    if (
      v.paid_diamonds !== undefined &&
      (!Number.isSafeInteger(v.paid_diamonds) || v.paid_diamonds < 0)
    )
      return false;
    if (
      v.drop_count !== undefined &&
      (!Number.isSafeInteger(v.drop_count) || v.drop_count !== v.drops.length)
    )
      return false;
    return validBonusMinimum({
      ...(v as unknown as Record<string, unknown>),
      bet_chips: v.bet_diamonds / v.diamonds_per_chip,
    });
  }
  if (version !== 3) return false;
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
      // The server owns the drop-value list; a saved request from an older rule is
      // sent as it was, so a completed game replays its receipt instead of being
      // refused here. A request with no chosen value never leaves this client.
      (input.game === 'plinko' &&
        (typeof input.budget.denomination !== 'number' ||
          !Number.isSafeInteger(input.budget.denomination) ||
          input.budget.denomination < 1 ||
          bonusTotal(input.budget) % input.budget.denomination !== 0)) ||
      (input.serverSeedHash !== undefined && !/^[a-f0-9]{64}$/.test(input.serverSeedHash))
    )
      throw new BonusRefusal('The Bonus Settings Could Not Be Verified');
    try {
      rememberBonus(userId, input);
    } catch (error) {
      // Another saved wager goes first; the page settles it by itself.
      if (error instanceof PriorBonusPending) throw error;
      // A wager is sent only once it is saved, so this one never left the
      // browser and nothing was charged: a refusal, never a wager to resend.
      reportError(error, 'DiamondBonusService.remember');
      throw new BonusRefusal(BONUS_NOT_SAVED);
    }
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
    if (error) {
      const kind = bonusErrorKind(error);
      // No code: nothing says whether the round opened, so it is sent again.
      if (kind === 'unknown') throw error;
      if (kind === 'transient') {
        const sends = (passingSends.get(input.commitId) ?? 0) + 1;
        if (sends < BONUS_SENDS_PER_REQUEST) {
          passingSends.set(input.commitId, sends);
          throw error;
        }
      }
      // This execution rolled back and nothing committed before it, so the
      // saved request is spent: the page deals a fresh ticket and lets go.
      forgetSends(input.commitId);
      clearPendingBonus(userId, input);
      throw new BonusRefusal(BONUS_NOT_TAKEN);
    }
    passingSends.delete(input.commitId);
    const result = data as Record<string, unknown> | null;
    if (result?.ok === false && typeof result.error === 'string') {
      forgetSends(input.commitId);
      clearPendingBonus(userId, input);
      throw new BonusRefusal(result.error, result.ticket === 'gone');
    }
    try {
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
    } catch (cause) {
      // Answered, but not in a form this browser can verify: the saved request
      // stays, and after BONUS_SENDS_PER_REQUEST of these the page stops.
      const answers = (unreadableSends.get(input.commitId) ?? 0) + 1;
      unreadableSends.set(input.commitId, answers);
      throw new BonusUnreadable(cause, answers >= BONUS_SENDS_PER_REQUEST);
    }
    forgetSends(input.commitId);
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
    const betChips = bonusTotal(input.budget) / result.diamonds_per_chip;
    // THE TABLE FOLLOWS THE FLOOR (contract 4, Dan 2026-09-21, R10/R11). Before
    // it, the boost named the table: Diamond (5) ordinarily, Super (4) for a
    // Super award. From it, the floor names it - fn_plinko_table_for_floor picks
    // the open board whose lowest slot still carries this stake's floor - which
    // is Super (4) for every half-the-stake floor and Super Double (6) for the
    // two thirds a Super award with the add-on paid. Board 5 is closed and no
    // new batch may name it. A receipt sealed before the rule keeps the table it
    // was dealt, so history still verifies.
    const sealedWithRule = result.payout_version !== undefined;
    // What the player paid for this stake, exactly as fn_diamond_game_paid_diamonds
    // computes it: the whole stake when nothing funded it, and otherwise the
    // spin entry plus whatever Double Diamonds added on top of the funded base.
    const paidDiamonds = input.budget.award
      ? input.budget.award.entryDiamonds + bonusAdded(input.budget)
      : bonusTotal(input.budget);
    const floor = diamondBonusFloor(betChips, boost, paidDiamonds, result.diamonds_per_chip);
    const expectedTable =
      result.payout_version === BONUS_PAYOUT_VERSION
        ? plinkoTableForFloor(betChips, floor)
        : plinkoTableVersion(boost);
    if (
      result.table_version !== input.tableVersion ||
      (sealedWithRule && result.table_version !== expectedTable) ||
      (sealedWithRule &&
        (result.payout_version === BONUS_PAYOUT_VERSION
          ? result.minimum_payout_chips !== floor ||
            (result.paid_diamonds !== undefined && result.paid_diamonds !== paidDiamonds)
          : boost === 2
            ? result.payout_version !== 3 ||
              result.minimum_payout_chips !== diamondBonusMinimum(betChips, 2)
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
      // The cap has to cover the first hundredth this round's contract lets a
      // player book, or there is no round: 1.01x before contract 4, 1.11x from it.
      Number(raw.cap_cents) <
        crashCashoutFloorCents(
          typeof raw.payout_version === 'number' ? raw.payout_version : undefined
        ) ||
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
