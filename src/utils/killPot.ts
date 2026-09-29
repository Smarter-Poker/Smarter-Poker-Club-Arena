/**
 * KILL AND HALF-KILL POTS, AS THE CLIENT READS THEM (rule manifest kill-v1).
 *
 * Everything a player sees about a kill comes from the server: the engine's
 * snapshot (`kill_hand`, `kill_next`), the hand's record
 * (`hand_history.kill_pot`) and the table row (`kill_mode`,
 * `kill_threshold_bb`). This module only PARSES those shapes and WORDS them.
 * It never sizes a kill hand: the effective limits and the kill blind are the
 * numbers the engine published, because a client that multiplied the big blind
 * itself would one day disagree with the controller that accepts the bet.
 *
 * Scope, from the manifest: cash tables, Fixed-Limit Hold'em (`flh`) and
 * Fixed-Limit Omaha Hi-Lo (`flo8`) only. Full kill plays at 2x the base limits,
 * half kill at 1.5x; the ordinary small and big blinds never change.
 */
import { fixedLimitBetSize, isFixedLimitVariant } from '../lib/bettingStructure';
import { blindLabel } from './handFormat';

export type KillMode = 'off' | 'half' | 'full';
export type ActiveKillMode = Exclude<KillMode, 'off'>;
export type KillerBlindSlot = 'none' | 'sb' | 'bb';

/** The thresholds a table may choose, in BASE big blinds (kill-v1). */
export const KILL_THRESHOLDS_BB = [8, 10, 12, 15] as const;
export type KillThresholdBb = (typeof KILL_THRESHOLDS_BB)[number];
export const DEFAULT_KILL_THRESHOLD_BB: KillThresholdBb = 10;

/** `kill_hand` from the engine snapshot: THIS hand is a kill hand. */
export interface KillHandSnapshot {
  mode: ActiveKillMode;
  smallBet: number;
  bigBet: number;
  killBlind: number;
  killerSeat: number;
  killerUserId: string;
  killerBlindSlot: KillerBlindSlot;
  chained: boolean;
}

/** `kill_next` from the engine snapshot: the NEXT hand is a kill hand. */
export interface KillNextSnapshot {
  mode: ActiveKillMode;
  /** Null when the engine could not size it (it then cancels at the deal). */
  smallBet: number | null;
  bigBet: number | null;
  killBlind: number | null;
  killerSeat: number;
  killerUserId: string;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const positive = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
};

export function isActiveKillMode(v: unknown): v is ActiveKillMode {
  return v === 'half' || v === 'full';
}

/** A table row's kill_mode, or null when the row did not carry the column. */
export function killModeOf(v: unknown): KillMode | null {
  if (v === 'off' || v === 'half' || v === 'full') return v;
  return v === undefined ? null : 'off';
}

/** The snapshot's `kill_hand`, or null on a base-limit hand or a malformed payload. */
export function parseKillHand(raw: unknown): KillHandSnapshot | null {
  const r = rec(raw);
  if (!r || !isActiveKillMode(r.mode)) return null;
  const smallBet = positive(r.small_bet);
  const bigBet = positive(r.big_bet);
  const killBlind = positive(r.kill_blind);
  const killerSeat = positive(r.killer_seat);
  if (smallBet === null || bigBet === null || killBlind === null || killerSeat === null) {
    return null;
  }
  const slot = r.killer_blind_slot;
  return {
    mode: r.mode,
    smallBet,
    bigBet,
    killBlind,
    killerSeat,
    killerUserId: typeof r.killer_user_id === 'string' ? r.killer_user_id : '',
    killerBlindSlot: slot === 'sb' || slot === 'bb' ? slot : 'none',
    chained: r.chained === true,
  };
}

/** The snapshot's `kill_next`, or null when no kill is scheduled. */
export function parseKillNext(raw: unknown): KillNextSnapshot | null {
  const r = rec(raw);
  if (!r || !isActiveKillMode(r.mode)) return null;
  const killerSeat = positive(r.killer_seat);
  if (killerSeat === null) return null;
  return {
    mode: r.mode,
    smallBet: positive(r.small_bet),
    bigBet: positive(r.big_bet),
    killBlind: positive(r.kill_blind),
    killerSeat,
    killerUserId: typeof r.killer_user_id === 'string' ? r.killer_user_id : '',
  };
}

/** "Kill Pot" for a full kill, "Half Kill" for a half kill. */
export function killPotName(mode: ActiveKillMode): string {
  return mode === 'half' ? 'Half Kill' : 'Kill Pot';
}

/** The felt pill on a kill hand: "Kill Pot 8/16", "Half Kill 6/12". */
export function killPotPillText(k: Pick<KillHandSnapshot, 'mode' | 'smallBet' | 'bigBet'>): string {
  return `${killPotName(k.mode)} ${blindLabel(k.smallBet)}/${blindLabel(k.bigBet)}`;
}

/** The masthead line when the next hand is a kill hand. */
export function killNextAnnouncement(n: Pick<KillNextSnapshot, 'mode'>): string {
  return n.mode === 'half' ? 'Next Hand Is A Half Kill' : 'Next Hand Is A Kill Pot';
}

/**
 * THE ONE LEGAL WAGER ON A FIXED-LIMIT STREET, SERVER FIRST.
 *
 * The engine publishes `fixed_bet_size` on every fixed-limit snapshot, sized
 * from the HAND (a kill hand's effective small bet), and that always wins. The
 * fallback exists for a snapshot from an engine older than the field: on a
 * kill hand it reads the kill limits the same snapshot published, and only on
 * a base-limit hand does it derive the size from the big blind. No path here
 * multiplies anything by a kill multiplier.
 */
export function fixedLimitStreetBet(args: {
  serverBetSize?: number | null;
  killHand: Pick<KillHandSnapshot, 'smallBet' | 'bigBet'> | null | undefined;
  bigBlind: number;
  stage?: string | null;
}): number {
  const server = Number(args.serverBetSize);
  if (Number.isFinite(server) && server > 0) return server;
  if (args.killHand) {
    const s = (args.stage || 'preflop').toLowerCase();
    return s === 'turn' || s === 'river' || s === 'showdown'
      ? args.killHand.bigBet
      : args.killHand.smallBet;
  }
  return fixedLimitBetSize(args.bigBlind, args.stage);
}

/** Can this variant carry a kill at all? kill-v1 covers exactly `flh` and `flo8`. */
export function isKillVariant(variant: string | null | undefined): boolean {
  return isFixedLimitVariant(variant);
}

/** A table's kill configuration, as the rules surfaces word it. */
export interface KillTableRule {
  mode: ActiveKillMode;
  thresholdBb: number;
}

/** The table row's kill rule, or null when it has none (or did not say). */
export function killTableRuleOf(row: {
  kill_mode?: unknown;
  kill_threshold_bb?: unknown;
}): KillTableRule | null {
  if (!isActiveKillMode(row.kill_mode)) return null;
  const t = positive(row.kill_threshold_bb);
  return { mode: row.kill_mode, thresholdBb: t ?? DEFAULT_KILL_THRESHOLD_BB };
}

/**
 * The kill-v1 rule, briefly, for the Game Rules sheet. Label/value rows in
 * the sheet's own grammar; every figure comes from the table's configuration.
 */
export function killRuleRows(rule: KillTableRule): Array<{ label: string; value: string }> {
  const full = rule.mode === 'full';
  return [
    { label: 'Type', value: full ? 'Full Kill, Double Limits' : 'Half Kill, 1.5x Limits' },
    {
      label: 'Trigger',
      value: `One Player Wins Every Pot Of A Hand Worth ${rule.thresholdBb.toLocaleString()} Big Blinds Or More`,
    },
    {
      label: 'Killer',
      value: full
        ? 'Posts A Live Kill Blind Of Two Big Blinds Next Hand'
        : 'Posts A Live Kill Blind Of One And A Half Big Blinds Next Hand',
    },
    { label: 'Blinds', value: 'The Small And Big Blinds Do Not Change' },
  ];
}

/** The cash game card's rule-line fragment: "Kill Pot At 10 BB". */
export function killRuleLinePart(rule: KillTableRule): string {
  return `${killPotName(rule.mode)} At ${rule.thresholdBb.toLocaleString()} BB`;
}

// ─── hand_history.kill_pot ─────────────────────────────────────────────────

export type KillCancelReason =
  | 'kill_mode_off'
  | 'not_fixed_limit'
  | 'tournament'
  | 'bomb_pot_hand'
  | 'killer_not_dealt_in'
  | 'invalid_base_big_blind'
  | 'half_kill_requires_even_minor_units';

/** The record's kill hand, as the rundown renders it. */
export interface KillPotRecordHand {
  mode: ActiveKillMode;
  multiplier: string;
  baseBigBlind: number;
  smallBet: number;
  bigBet: number;
  killBlind: number;
  killerUserId: string;
  killerSeat: number;
  killerBlindSlot: KillerBlindSlot;
  chained: boolean;
}

export interface KillPotRecordView {
  killHand: KillPotRecordHand | null;
  nextKill: { mode: ActiveKillMode; killerUserId: string; killerSeat: number } | null;
  cancelled: { reason: string; killerUserId: string; killerSeat: number } | null;
}

/** `hand_history.kill_pot`, or null when the hand has no kill facts. */
export function parseKillPotRecord(raw: unknown): KillPotRecordView | null {
  const r = rec(raw);
  if (!r) return null;
  const k = rec(r.kill_hand);
  const n = rec(r.next_kill);
  const c = rec(r.cancelled);
  let killHand: KillPotRecordHand | null = null;
  if (k && isActiveKillMode(k.mode)) {
    const baseBigBlind = positive(k.base_big_blind);
    const smallBet = positive(k.small_bet);
    const bigBet = positive(k.big_bet);
    const killBlind = positive(k.kill_blind);
    const killerSeat = positive(k.killer_seat);
    if (baseBigBlind && smallBet && bigBet && killBlind && killerSeat) {
      const slot = k.killer_blind_slot;
      killHand = {
        mode: k.mode,
        multiplier: typeof k.multiplier === 'string' ? k.multiplier : '',
        baseBigBlind,
        smallBet,
        bigBet,
        killBlind,
        killerUserId: typeof k.killer_user_id === 'string' ? k.killer_user_id : '',
        killerSeat,
        killerBlindSlot: slot === 'sb' || slot === 'bb' ? slot : 'none',
        chained: k.chained === true,
      };
    }
  }
  const nextKill =
    n && isActiveKillMode(n.mode) && positive(n.killer_seat)
      ? {
          mode: n.mode,
          killerUserId: typeof n.killer_user_id === 'string' ? n.killer_user_id : '',
          killerSeat: positive(n.killer_seat) as number,
        }
      : null;
  const cancelled =
    c && typeof c.reason === 'string'
      ? {
          reason: c.reason,
          killerUserId: typeof c.killer_user_id === 'string' ? c.killer_user_id : '',
          killerSeat: positive(c.killer_seat) ?? 0,
        }
      : null;
  if (!killHand && !nextKill && !cancelled) return null;
  return { killHand, nextKill, cancelled };
}

const CANCEL_TEXT: Record<KillCancelReason, string> = {
  killer_not_dealt_in: 'The Killer Was Not Dealt In',
  kill_mode_off: 'Kill Pots Were Switched Off',
  bomb_pot_hand: 'This Hand Was A Bomb Pot',
  not_fixed_limit: 'This Hand Was Not Fixed Limit',
  tournament: 'Kill Pots Do Not Run In Tournaments',
  invalid_base_big_blind: 'The Big Blind Could Not Be Killed',
  half_kill_requires_even_minor_units: 'A Half Kill Needs An Even Big Blind',
};

/** Why a scheduled kill did not play, in the rundown's words. */
export function killCancelReasonText(reason: string): string {
  return (CANCEL_TEXT as Record<string, string>)[reason] ?? 'The Kill Was Cancelled';
}

/** "4/8": a fixed-limit ladder from its small bet. */
export function limitPair(smallBet: number, bigBet: number): string {
  return `${blindLabel(smallBet)}/${blindLabel(bigBet)}`;
}
