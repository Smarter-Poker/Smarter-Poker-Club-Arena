/**
 * KILL AND HALF-KILL POTS, rule manifest `kill-v1` (2026-09-22).
 *
 * A fixed-limit cash house rule: a player who SCOOPS a pot of at least the
 * table's threshold (in BASE big blinds) is the killer on the next hand. That
 * hand is played at raised limits - full kill doubles them, half kill raises
 * them by half - and the killer posts a live KILL BLIND equal to the raised
 * small bet before the cards are dealt.
 *
 * This module is the single source of truth for the arithmetic, the scoop
 * test and the pending-kill ledger. It does no I/O. Everything money-shaped is
 * done in exact INTEGER MINOR UNITS (cents for chips, whole units for
 * Diamonds) with a rational multiplier, so a half kill can never mint or lose a
 * fraction of a cent: if the base big blind times the multiplier is not a whole
 * number of minor units the configuration is refused rather than rounded.
 *
 * Stake convention (BettingStructure.ts): the base small bet IS the table's big
 * blind and the base big bet is twice it. So a table posting 2/4 blinds is a
 * "4/8" limit game; a full kill plays it 8/16 with an 8 kill blind, and a half
 * kill plays it 6/12 with a 6 kill blind. The ordinary small and big blinds
 * never change.
 */

export const KILL_RULE_VERSION = 'kill-v1';

export type KillMode = 'off' | 'half' | 'full';
export type ActiveKillMode = Exclude<KillMode, 'off'>;

/** The thresholds the table setting accepts, in BASE big blinds. */
export const KILL_THRESHOLDS_BB = [8, 10, 12, 15] as const;
export type KillThresholdBb = (typeof KILL_THRESHOLDS_BB)[number];
export const DEFAULT_KILL_THRESHOLD_BB: KillThresholdBb = 10;

export interface KillMultiplier {
  num: 2 | 3;
  den: 1 | 2;
}

export type KillAsset = 'chips' | 'diamonds';

/** Full kill is 2/1, half kill is 3/2. Off has no multiplier. */
export function killMultiplier(mode: KillMode): KillMultiplier | null {
  if (mode === 'full') return { num: 2, den: 1 };
  if (mode === 'half') return { num: 3, den: 2 };
  return null;
}

export function multiplierLabel(m: KillMultiplier): string {
  return `${m.num}/${m.den}`;
}

/** Minor units per whole chip: cents for chips, one for Diamonds. */
export function minorUnitsPer(asset: KillAsset | undefined): 100 | 1 {
  return asset === 'diamonds' ? 1 : 100;
}

/**
 * An amount in exact minor units, or null when it is not a whole, positive,
 * safe number of them. Chip amounts arrive as float dollars that are cents by
 * rule, so a sub-nanocent of IEEE noise is tolerated and anything more is not.
 */
export function exactMinorUnits(amount: number, asset: KillAsset | undefined): number | null {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const scaled = amount * minorUnitsPer(asset);
  const minor = Math.round(scaled);
  if (!Number.isSafeInteger(minor) || minor <= 0) return null;
  if (Math.abs(scaled - minor) > 1e-6) return null;
  return minor;
}

export function fromMinorUnits(minor: number, asset: KillAsset | undefined): number {
  return minor / minorUnitsPer(asset);
}

export type KillStakesRefusal =
  | 'kill_mode_off'
  | 'invalid_base_big_blind'
  | 'half_kill_requires_even_minor_units';

export type KillStakes =
  | {
      ok: true;
      mode: ActiveKillMode;
      multiplier: KillMultiplier;
      baseBigBlind: number;
      baseBigBlindMinor: number;
      /** Effective small bet (preflop and flop). Equals the kill blind. */
      smallBet: number;
      /** Effective big bet (turn and river): twice the effective small bet. */
      bigBet: number;
      /** The live blind the killer posts. */
      killBlind: number;
      smallBetMinor: number;
      bigBetMinor: number;
    }
  | { ok: false; reason: KillStakesRefusal };

/**
 * The effective limits of a kill hand, or the precise reason there cannot be
 * one. Exactness rule: base big blind (minor units) x m must be an integer.
 */
export function killStakes(input: {
  baseBigBlind: number;
  mode: KillMode;
  asset?: KillAsset;
}): KillStakes {
  const multiplier = killMultiplier(input.mode);
  if (!multiplier) return { ok: false, reason: 'kill_mode_off' };
  const bbMinor = exactMinorUnits(input.baseBigBlind, input.asset);
  if (bbMinor === null) return { ok: false, reason: 'invalid_base_big_blind' };
  const scaled = bbMinor * multiplier.num;
  if (scaled % multiplier.den !== 0) {
    return { ok: false, reason: 'half_kill_requires_even_minor_units' };
  }
  const smallBetMinor = scaled / multiplier.den;
  const bigBetMinor = smallBetMinor * 2;
  if (!Number.isSafeInteger(bigBetMinor)) return { ok: false, reason: 'invalid_base_big_blind' };
  return {
    ok: true,
    mode: input.mode as ActiveKillMode,
    multiplier,
    baseBigBlind: fromMinorUnits(bbMinor, input.asset),
    baseBigBlindMinor: bbMinor,
    smallBet: fromMinorUnits(smallBetMinor, input.asset),
    bigBet: fromMinorUnits(bigBetMinor, input.asset),
    killBlind: fromMinorUnits(smallBetMinor, input.asset),
    smallBetMinor,
    bigBetMinor,
  };
}

/**
 * Is the contested total at least `thresholdBb` BASE big blinds? Compared in
 * integer minor units. The contested total is a sum of cent amounts, so it is
 * rounded to the nearest minor unit (float drift) - the base big blind is not,
 * it must be exact.
 */
export function killThresholdMet(input: {
  contestedTotal: number;
  baseBigBlind: number;
  thresholdBb: number;
  asset?: KillAsset;
}): { met: boolean; contestedMinor: number; thresholdMinor: number } | null {
  const bbMinor = exactMinorUnits(input.baseBigBlind, input.asset);
  if (bbMinor === null || !Number.isSafeInteger(input.thresholdBb) || input.thresholdBb <= 0) {
    return null;
  }
  if (!Number.isFinite(input.contestedTotal)) return null;
  const contestedMinor = Math.max(0, Math.round(input.contestedTotal * minorUnitsPer(input.asset)));
  const thresholdMinor = input.thresholdBb * bbMinor;
  return { met: contestedMinor >= thresholdMinor, contestedMinor, thresholdMinor };
}

// ─────────────────────────────────────────────────────────────────────────────
// Table settings
// ─────────────────────────────────────────────────────────────────────────────

export interface KillSettings {
  mode: KillMode;
  thresholdBb: KillThresholdBb;
}

export const KILL_OFF: KillSettings = Object.freeze({
  mode: 'off',
  thresholdBb: DEFAULT_KILL_THRESHOLD_BB,
}) as KillSettings;

/**
 * The table's kill configuration from its row. A row without the columns (an
 * older shape) is `off`. A value the database constraints would refuse is
 * treated as `off` too: an unreadable setting must never switch money rules on.
 */
export function readKillSettings(
  row: { kill_mode?: unknown; kill_threshold_bb?: unknown } | null | undefined
): KillSettings {
  const mode = row?.kill_mode;
  if (mode !== 'half' && mode !== 'full') return KILL_OFF;
  const raw = row?.kill_threshold_bb;
  const threshold = raw === undefined || raw === null ? DEFAULT_KILL_THRESHOLD_BB : Number(raw);
  if (!(KILL_THRESHOLDS_BB as readonly number[]).includes(threshold)) return KILL_OFF;
  return { mode, thresholdBb: threshold as KillThresholdBb };
}

export type KillIneligibleReason =
  | 'kill_mode_off'
  | 'not_fixed_limit'
  | 'tournament'
  | 'bomb_pot_hand';

const KILL_VARIANTS = new Set(['flh', 'flo8']);

/** Why a hand at this table cannot be (or trigger) a kill, or null when it can. */
export function killIneligibility(input: {
  mode: KillMode;
  variant: string | null | undefined;
  isTournament: boolean;
  isBombHand: boolean;
}): KillIneligibleReason | null {
  if (input.mode === 'off') return 'kill_mode_off';
  if (input.isTournament) return 'tournament';
  if (!KILL_VARIANTS.has(String(input.variant ?? '').toLowerCase())) return 'not_fixed_limit';
  if (input.isBombHand) return 'bomb_pot_hand';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scoop evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoopAward {
  userId: string;
  potIndex: number;
  low?: boolean;
  /** Run index on a Run It Twice hand; absent on a single board. */
  board?: number | null;
}

export interface ScoopPot {
  index: number;
  amount: number;
}

export type ScoopReason = 'scoop' | 'split' | 'no_awards' | 'uncovered_pot';

export interface ScoopEvidence {
  scooper: string | null;
  reason: ScoopReason;
  winners: string[];
  pots: number;
  awards: number;
  boards: number[];
  lowAwards: number;
}

/**
 * Did exactly ONE player receive every award of the hand? Every pot (main and
 * side), both halves of every hi-lo pot and every board/run. A hi-lo pot with
 * no qualifying low has only high awards, so it is wholly its high winner's.
 *
 * A pot that carries money but no award is not a scoop: the evidence cannot
 * show who won it, and a kill is never claimed on evidence that is missing.
 */
export function evaluateScoop(pots: ScoopPot[], awards: ScoopAward[]): ScoopEvidence {
  const boards = [...new Set(awards.map((a) => (a.board == null ? 1 : Number(a.board))))].sort(
    (a, b) => a - b
  );
  const winners = [...new Set(awards.map((a) => a.userId).filter(Boolean))].sort();
  const lowAwards = awards.filter((a) => a.low === true).length;
  const moneyPots = pots.filter((p) => Number(p.amount) > 0).map((p) => p.index);
  const base = { winners, pots: moneyPots.length, awards: awards.length, boards, lowAwards };
  if (awards.length === 0 || winners.length === 0) {
    return { scooper: null, reason: 'no_awards', ...base };
  }
  if (winners.length > 1 || awards.some((a) => !a.userId)) {
    return { scooper: null, reason: 'split', ...base };
  }
  const awardedPots = new Set(awards.map((a) => a.potIndex));
  if (moneyPots.some((index) => !awardedPots.has(index))) {
    return { scooper: null, reason: 'uncovered_pot', ...base };
  }
  return { scooper: winners[0], reason: 'scoop', ...base };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending kill, kill hand and the hand-history record
// ─────────────────────────────────────────────────────────────────────────────

export interface PendingKill {
  ruleVersion: typeof KILL_RULE_VERSION;
  /** hand_history.id of the triggering hand; bound when that id is minted. */
  triggerHandId: string | null;
  /** The triggering hand's globally allocated number: the ledger key. */
  triggerHandNumber: number;
  killerUserId: string;
  killerSeat: number;
  /** Frozen at the trigger; a later settings change does not alter it. */
  mode: ActiveKillMode;
  thresholdBb: number;
  /** The triggering hand was itself a kill hand. */
  chained: boolean;
  contestedTotal: number;
}

export type KillerBlindSlot = 'none' | 'sb' | 'bb';

/** Frozen into HandConfig for a kill hand. Every reader sizes from this. */
export interface KillHandState {
  ruleVersion: typeof KILL_RULE_VERSION;
  mode: ActiveKillMode;
  multiplier: KillMultiplier;
  baseBigBlind: number;
  smallBet: number;
  bigBet: number;
  killBlind: number;
  killerUserId: string;
  killerSeat: number;
  killerBlindSlot: KillerBlindSlot;
  triggerHandId: string | null;
  triggerHandNumber: number;
  chained: boolean;
  thresholdBb: number;
}

export type KillCancelReason = KillIneligibleReason | 'killer_not_dealt_in' | KillStakesRefusal;

export interface KillCancellation {
  reason: KillCancelReason;
  pending: PendingKill;
}

export type KillDealDecision =
  | { kind: 'none' }
  | { kind: 'kill'; hand: KillHandState }
  | { kind: 'cancel'; cancellation: KillCancellation };

/**
 * What the next deal does with a pending kill: play it, cancel it (with the
 * reason recorded), or nothing when none is pending. The killer must be in the
 * roster this hand is dealt to; their seat is read from that roster.
 */
export function decideKillForDeal(input: {
  pending: PendingKill | null;
  settings: KillSettings;
  variant: string | null | undefined;
  isTournament: boolean;
  isBombHand: boolean;
  asset?: KillAsset;
  baseBigBlind: number;
  roster: Array<{ userId: string; seat: number }>;
  sbSeat: number | null;
  bbSeat: number | null;
}): KillDealDecision {
  const pending = input.pending;
  if (!pending) return { kind: 'none' };
  const cancel = (reason: KillCancelReason): KillDealDecision => ({
    kind: 'cancel',
    cancellation: { reason, pending },
  });
  // The CURRENT table mode gates whether a kill is played at all ('off' never
  // kills); the pending kill's own mode is what it is played at.
  const ineligible = killIneligibility({
    mode: input.settings.mode,
    variant: input.variant,
    isTournament: input.isTournament,
    isBombHand: input.isBombHand,
  });
  if (ineligible) return cancel(ineligible);
  const killer = input.roster.find((p) => p.userId === pending.killerUserId);
  if (!killer) return cancel('killer_not_dealt_in');
  const stakes = killStakes({
    baseBigBlind: input.baseBigBlind,
    mode: pending.mode,
    asset: input.asset,
  });
  if (!stakes.ok) return cancel(stakes.reason);
  const killerBlindSlot: KillerBlindSlot =
    killer.seat === input.sbSeat ? 'sb' : killer.seat === input.bbSeat ? 'bb' : 'none';
  const hand: KillHandState = {
    ruleVersion: KILL_RULE_VERSION,
    mode: stakes.mode,
    multiplier: stakes.multiplier,
    baseBigBlind: stakes.baseBigBlind,
    smallBet: stakes.smallBet,
    bigBet: stakes.bigBet,
    killBlind: stakes.killBlind,
    killerUserId: killer.userId,
    killerSeat: killer.seat,
    killerBlindSlot,
    triggerHandId: pending.triggerHandId,
    triggerHandNumber: pending.triggerHandNumber,
    chained: pending.chained,
    thresholdBb: pending.thresholdBb,
  };
  return { kind: 'kill', hand: freezeKillHand(hand) };
}

export function freezeKillHand(hand: KillHandState): KillHandState {
  return Object.freeze({ ...hand, multiplier: Object.freeze({ ...hand.multiplier }) });
}

/** The fixed-limit small bet a hand plays at: the kill's, else the base. */
export function handFixedLimitSmallBet(config: {
  bigBlind: number;
  killPot?: Pick<KillHandState, 'smallBet'> | null;
}): number {
  return config.killPot?.smallBet ?? config.bigBlind;
}

export type KillTriggerOutcome =
  | 'triggered'
  | KillIneligibleReason
  | 'below_threshold'
  | 'no_scoop'
  | 'unmeasurable';

export interface KillTriggerResult {
  outcome: KillTriggerOutcome;
  pending: PendingKill | null;
  scoop: ScoopEvidence | null;
  contestedTotal: number;
  thresholdAmount: number | null;
}

/**
 * The trigger, evaluated once from a hand's authoritative settlement. The
 * settings are the ones frozen at that hand's deal. Contested total is the sum
 * of the pots after uncalled bets are returned and before any deduction.
 */
export function evaluateKillTrigger(input: {
  handNumber: number;
  settings: KillSettings;
  variant: string | null | undefined;
  isTournament: boolean;
  isBombHand: boolean;
  asset?: KillAsset;
  baseBigBlind: number;
  killHand: KillHandState | null;
  pots: ScoopPot[];
  awards: ScoopAward[];
  contestedTotal: number;
  seatOf: (userId: string) => number | null | undefined;
}): KillTriggerResult {
  const none = (
    outcome: KillTriggerOutcome,
    scoop: ScoopEvidence | null = null,
    thresholdAmount: number | null = null
  ): KillTriggerResult => ({
    outcome,
    pending: null,
    scoop,
    contestedTotal: input.contestedTotal,
    thresholdAmount,
  });
  const ineligible = killIneligibility({
    mode: input.settings.mode,
    variant: input.variant,
    isTournament: input.isTournament,
    isBombHand: input.isBombHand,
  });
  if (ineligible) return none(ineligible);
  const scoop = evaluateScoop(input.pots, input.awards);
  const threshold = killThresholdMet({
    contestedTotal: input.contestedTotal,
    baseBigBlind: input.baseBigBlind,
    thresholdBb: input.settings.thresholdBb,
    asset: input.asset,
  });
  if (!threshold) return none('unmeasurable', scoop);
  const thresholdAmount = fromMinorUnits(threshold.thresholdMinor, input.asset);
  if (!scoop.scooper) return none('no_scoop', scoop, thresholdAmount);
  if (!threshold.met) return none('below_threshold', scoop, thresholdAmount);
  const seat = Number(input.seatOf(scoop.scooper));
  if (!Number.isSafeInteger(seat) || seat <= 0) return none('unmeasurable', scoop, thresholdAmount);
  return {
    outcome: 'triggered',
    scoop,
    contestedTotal: fromMinorUnits(threshold.contestedMinor, input.asset),
    thresholdAmount,
    pending: {
      ruleVersion: KILL_RULE_VERSION,
      triggerHandId: null,
      triggerHandNumber: input.handNumber,
      killerUserId: scoop.scooper,
      killerSeat: seat,
      mode: input.settings.mode as ActiveKillMode,
      thresholdBb: input.settings.thresholdBb,
      // Chained kills never escalate: the new kill carries the configured
      // mode, applied to the BASE big blind, whatever the trigger hand played.
      chained: input.killHand !== null,
      contestedTotal: fromMinorUnits(threshold.contestedMinor, input.asset),
    },
  };
}

/** hand_history.kill_pot, snake_case like every other jsonb column there. */
export interface KillPotRecord {
  rule_version: typeof KILL_RULE_VERSION;
  kill_hand: {
    mode: ActiveKillMode;
    multiplier: string;
    base_big_blind: number;
    small_bet: number;
    big_bet: number;
    kill_blind: number;
    killer_user_id: string;
    killer_seat: number;
    killer_blind_slot: KillerBlindSlot;
    trigger_hand_id: string | null;
    trigger_hand_number: number;
    chained: boolean;
  } | null;
  next_kill: {
    killer_user_id: string;
    killer_seat: number;
    mode: ActiveKillMode;
    multiplier: string;
    threshold_bb: number;
    threshold_amount: number | null;
    contested_total: number;
    trigger_hand_id: string | null;
    trigger_hand_number: number;
    chained: boolean;
    scoop: {
      winner: string | null;
      pots: number;
      awards: number;
      boards: number[];
      low_awards: number;
    };
  } | null;
  cancelled: {
    reason: KillCancelReason;
    killer_user_id: string;
    killer_seat: number;
    mode: ActiveKillMode;
    trigger_hand_id: string | null;
    trigger_hand_number: number;
  } | null;
}

/** The record for one hand, or null when it neither played, set nor cancelled a kill. */
export function buildKillPotRecord(input: {
  killHand: KillHandState | null;
  trigger: KillTriggerResult | null;
  cancellation: KillCancellation | null;
}): KillPotRecord | null {
  const k = input.killHand;
  const next = input.trigger?.pending ?? null;
  const c = input.cancellation;
  if (!k && !next && !c) return null;
  return {
    rule_version: KILL_RULE_VERSION,
    kill_hand: k
      ? {
          mode: k.mode,
          multiplier: multiplierLabel(k.multiplier),
          base_big_blind: k.baseBigBlind,
          small_bet: k.smallBet,
          big_bet: k.bigBet,
          kill_blind: k.killBlind,
          killer_user_id: k.killerUserId,
          killer_seat: k.killerSeat,
          killer_blind_slot: k.killerBlindSlot,
          trigger_hand_id: k.triggerHandId,
          trigger_hand_number: k.triggerHandNumber,
          chained: k.chained,
        }
      : null,
    next_kill:
      next && input.trigger
        ? {
            killer_user_id: next.killerUserId,
            killer_seat: next.killerSeat,
            mode: next.mode,
            multiplier: multiplierLabel(killMultiplier(next.mode)!),
            threshold_bb: next.thresholdBb,
            threshold_amount: input.trigger.thresholdAmount,
            contested_total: next.contestedTotal,
            trigger_hand_id: next.triggerHandId,
            trigger_hand_number: next.triggerHandNumber,
            chained: next.chained,
            scoop: {
              winner: input.trigger.scoop?.scooper ?? null,
              pots: input.trigger.scoop?.pots ?? 0,
              awards: input.trigger.scoop?.awards ?? 0,
              boards: [...(input.trigger.scoop?.boards ?? [])],
              low_awards: input.trigger.scoop?.lowAwards ?? 0,
            },
          }
        : null,
    cancelled: c
      ? {
          reason: c.reason,
          killer_user_id: c.pending.killerUserId,
          killer_seat: c.pending.killerSeat,
          mode: c.pending.mode,
          trigger_hand_id: c.pending.triggerHandId,
          trigger_hand_number: c.pending.triggerHandNumber,
        }
      : null,
  };
}

/**
 * The pending kill carried by a table's last settled hand_history row, or null.
 * The row's own id is the trigger hand id. Anything malformed restores nothing.
 */
export function pendingKillFromHistoryRow(
  row: { id?: unknown; hand_number?: unknown; kill_pot?: unknown } | null | undefined
): PendingKill | null {
  const record = row?.kill_pot as Partial<KillPotRecord> | null | undefined;
  const next = record && typeof record === 'object' ? record.next_kill : null;
  if (!next || typeof next !== 'object') return null;
  if (record!.rule_version !== KILL_RULE_VERSION) return null;
  const mode = next.mode;
  if (mode !== 'half' && mode !== 'full') return null;
  const seat = Number(next.killer_seat);
  const handNumber = Number(row?.hand_number ?? next.trigger_hand_number);
  if (
    typeof next.killer_user_id !== 'string' ||
    !next.killer_user_id ||
    !Number.isSafeInteger(seat) ||
    seat <= 0 ||
    !Number.isSafeInteger(handNumber)
  ) {
    return null;
  }
  const threshold = Number(next.threshold_bb);
  const rowId = typeof row?.id === 'string' && row.id ? row.id : null;
  return {
    ruleVersion: KILL_RULE_VERSION,
    triggerHandId:
      rowId ?? (typeof next.trigger_hand_id === 'string' ? next.trigger_hand_id : null),
    triggerHandNumber: handNumber,
    killerUserId: next.killer_user_id,
    killerSeat: seat,
    mode,
    thresholdBb: Number.isFinite(threshold) ? threshold : DEFAULT_KILL_THRESHOLD_BB,
    chained: next.chained === true,
    contestedTotal: Number(next.contested_total) || 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger: one pending kill per table, keyed by its trigger hand
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-table kill ledger. Pure state, no I/O; the engine calls it at the
 * two hand boundaries.
 *
 *  - decide() is side-effect free, so a deal that is prepared and then not
 *    started changes nothing. commitDeal() is called once the hand exists.
 *  - A kill hand does NOT consume its pending kill when it is dealt. It is
 *    consumed when that hand SETTLES, so a kill hand abandoned by a crash or a
 *    void leaves the kill pending and the re-dealt hand is still the kill hand.
 *  - settle() is keyed by the hand number; a duplicate settlement event for the
 *    same hand returns the same record and schedules nothing new.
 */
export class KillPotSchedule {
  private pending: PendingKill | null = null;
  private lastSettled: { handNumber: number; result: KillSettleResult } | null = null;

  getPending(): PendingKill | null {
    return this.pending;
  }

  /** Engine start: adopt the pending kill from the last settled hand. */
  restore(pending: PendingKill | null): void {
    this.pending = pending;
  }

  decide(input: Omit<Parameters<typeof decideKillForDeal>[0], 'pending'>): KillDealDecision {
    return decideKillForDeal({ ...input, pending: this.pending });
  }

  /** The hand now exists. A cancellation is final; a kill stays pending until settled. */
  commitDeal(decision: KillDealDecision): void {
    if (
      decision.kind === 'cancel' &&
      this.pending?.triggerHandNumber === decision.cancellation.pending.triggerHandNumber
    ) {
      this.pending = null;
    }
  }

  settle(
    input: Parameters<typeof evaluateKillTrigger>[0] & {
      cancellation: KillCancellation | null;
    }
  ): KillSettleResult {
    if (this.lastSettled?.handNumber === input.handNumber) {
      return { ...this.lastSettled.result, duplicate: true };
    }
    // The kill this hand played is spent, whatever the outcome below.
    if (input.killHand && this.pending?.triggerHandNumber === input.killHand.triggerHandNumber) {
      this.pending = null;
    }
    const trigger = evaluateKillTrigger(input);
    if (trigger.pending) this.pending = trigger.pending;
    const result: KillSettleResult = {
      trigger,
      record: buildKillPotRecord({
        killHand: input.killHand,
        trigger,
        cancellation: input.cancellation,
      }),
      duplicate: false,
    };
    this.lastSettled = { handNumber: input.handNumber, result };
    return result;
  }

  /**
   * The triggering hand's hand_history id is minted by settlement after the
   * trigger is evaluated. Bind it once, to the pending kill and to the record
   * that is about to be written under that id.
   */
  bindTriggerHandId(
    handNumber: number,
    handId: string,
    record: KillPotRecord | null
  ): KillPotRecord | null {
    if (
      this.pending &&
      this.pending.triggerHandNumber === handNumber &&
      !this.pending.triggerHandId
    ) {
      this.pending = { ...this.pending, triggerHandId: handId };
    }
    if (!record?.next_kill || record.next_kill.trigger_hand_number !== handNumber) return record;
    return {
      ...record,
      next_kill: {
        ...record.next_kill,
        trigger_hand_id: record.next_kill.trigger_hand_id ?? handId,
      },
    };
  }
}

export interface KillSettleResult {
  trigger: KillTriggerResult;
  record: KillPotRecord | null;
  duplicate: boolean;
}
