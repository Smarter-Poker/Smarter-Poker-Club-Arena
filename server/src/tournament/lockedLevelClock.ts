/**
 * LOCKED LEVEL CLOCK (owner update 2026-10-31)
 * Non-highlighted events are capped at eight minutes. Only is_pinned events
 * may retain the ten-minute deep clock. Faster turbo/freeroll clocks stay.
 *
 * Dan, verbatim: "TOURNAMENT LEVELS CAN NEVER EVER BE A 'RANGE'. ALL
 * TOURNAMENTS NEED TO HAVE SET MINUTE BLIND LEVELS. TURBOS AND FREE ROLLS 5
 * MINUTE LEVELS, STANDARD TOURNAMENTS AND BOUNTY TOURNAMENTS 8 MINUTE LEVELS,
 * DEEP STACK TOURNAMENTS 10 MINUTE LEVELS. EVERY LEVEL MUST BE LOCKED IN AND
 * DEFINED AND NEVER RANDOM." Spins and Sit & Gos are explicitly out of scope.
 *
 * Every playable level of a multi-table tournament (MTT rows and satellites)
 * carries ONE clock for the whole event. The ladders still climb; only the
 * minutes are fixed. The database applies the identical rule on every insert
 * through `fn_ca_locked_level_minutes` / `tournaments_lock_level_clock`, so a
 * creator that forgets this module still cannot publish a tapered clock.
 * The two implementations are pinned to each other by
 * `tests/tournament-levels-are-locked.law.test.ts`.
 *
 * Classification, first match wins:
 *   1. free entry, or named Free Buy / Freeroll      -> 5  (freeroll)
 *   2. named Turbo / Hyper (not a satellite)          -> 5  (turbo)
 *   3. named Deep (not a satellite)                   -> 10 (deep stack)
 *   4. a bounty, PKO, mystery or knockout format      -> 8  (bounty)
 *   5. the authored opening clock:
 *        5 minutes or less                            -> 5  (turbo ladder)
 *        12 minutes or more, or already locked at 10  -> 10 (deep ladder)
 *        anything else                                -> 8  (standard)
 *
 * Rule 5 reads the clock the creator authored (the TURBO preset opens at 4,
 * DEEPSTACK at 12, STANDARD at 10 and tapers). Once locked, a structure
 * re-classifies to the same minutes, so the rule is idempotent.
 */

import { mttLateRegistrationMinutes, mttSpeedColumns } from './mttStructurePolicy.js';

export const LOCKED_LEVEL_MINUTES = {
  freeroll: 5,
  turbo: 5,
  standard: 8,
  bounty: 8,
  deep_stack: 10,
} as const;

export type LockedLevelCategory = keyof typeof LOCKED_LEVEL_MINUTES;

/** A Free Buy keeps Dan's one hour of late registration on a 5 minute clock. */
export const FREE_BUY_LATE_REG_MINUTES = 60;

export interface LockedLevelFacts {
  name?: unknown;
  buy_in_amount?: unknown;
  buy_in_fee?: unknown;
  is_bounty?: unknown;
  is_pko?: unknown;
  is_mystery_bounty?: unknown;
  bounty_amount?: unknown;
  variant?: unknown;
  tournament_type?: unknown;
  blind_structure?: unknown;
  is_pinned?: unknown;
}

function parseStructure(raw: unknown): unknown[] {
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed : [];
}

function levelMinutes(entry: unknown): number | null {
  if (entry === null || typeof entry !== 'object') return null;
  const row = entry as Record<string, unknown>;
  if (row.isBreak === true) return null;
  const minutes = Number(row.durationMinutes ?? row.duration_minutes);
  if (Number.isFinite(minutes) && minutes > 0) return minutes;
  const seconds = Number(row.duration);
  if (Number.isFinite(seconds) && seconds > 0) return seconds / 60;
  return null;
}

function isBountyFormat(facts: LockedLevelFacts, name: string, satellite: boolean): boolean {
  if (facts.is_bounty === true || facts.is_pko === true || facts.is_mystery_bounty === true) {
    return true;
  }
  const variant = String(facts.variant ?? '').toLowerCase();
  if (['bounty', 'progressive_bounty', 'mystery_bounty'].includes(variant)) {
    return true;
  }
  const bounty = Number(facts.bounty_amount);
  if (Number.isFinite(bounty) && bounty > 0) return true;
  return !satellite && /bounty|pko|knockout/.test(name);
}

export function lockedLevelCategory(facts: LockedLevelFacts): LockedLevelCategory {
  const name = String(facts.name ?? '').toLowerCase();
  const satellite =
    /satellite/.test(name) ||
    String(facts.variant ?? '').toLowerCase() === 'satellite' ||
    String(facts.tournament_type ?? '').toUpperCase() === 'SATELLITE';
  const priced = facts.buy_in_amount !== undefined && facts.buy_in_amount !== null;
  const entry = (Number(facts.buy_in_amount) || 0) + (Number(facts.buy_in_fee) || 0);
  if ((priced && entry === 0) || /free ?buy|free ?roll/.test(name)) return 'freeroll';
  if (!satellite && /turbo|hyper/.test(name)) return 'turbo';
  if (!satellite && /deep/.test(name)) return 'deep_stack';
  if (isBountyFormat(facts, name, satellite)) return 'bounty';

  const clocks = parseStructure(facts.blind_structure)
    .map(levelMinutes)
    .filter((m): m is number => m !== null);
  if (clocks.length === 0) return 'standard';
  const opening = clocks[0];
  const uniform = clocks.every((m) => m === opening);
  if (opening <= 5) return 'turbo';
  if (opening >= 12 || (uniform && opening === 10)) return 'deep_stack';
  return 'standard';
}

export function lockedLevelMinutes(facts: LockedLevelFacts): 5 | 8 | 10 {
  const minutes = LOCKED_LEVEL_MINUTES[lockedLevelCategory(facts)];
  return minutes === 10 && facts.is_pinned !== true ? 8 : minutes;
}

/** Every playable level carries exactly `minutes`. Breaks keep their own clock.
 * Legacy `duration` (seconds) and `duration_minutes` keys are dropped so no
 * reader can find a second, disagreeing clock on the same level. */
export function lockStructureClock<T>(structure: readonly T[], minutes: number): T[] {
  return structure.map((entry) => {
    if (entry === null || typeof entry !== 'object') return entry;
    const row = entry as Record<string, unknown>;
    if (row.isBreak === true) return entry;
    const { duration: _seconds, duration_minutes: _snake, ...rest } = row;
    return { ...rest, durationMinutes: minutes } as T;
  });
}

/** True for every tournament the rule governs: MTTs and satellites. Spins and
 * Sit & Gos keep their own ladders (Dan: "THIS DOES NOT EFFECT SPINS OR SIT N
 * GO'S"). */
export function isLockedClockFormat(row: Record<string, unknown>): boolean {
  const type = String(row.tournament_type ?? '').toUpperCase();
  const variant = String(row.variant ?? '').toLowerCase();
  if (type !== 'MTT' && type !== 'SATELLITE') return false;
  if (variant === 'spin' || variant === 'sng') return false;
  return true;
}

/** Applies the locked clock to a tournament row before it is written.
 * Late registration that was derived from the authored clock is re-derived from
 * the locked one, so the level count the engine enforces and the minutes the
 * lobby prints keep agreeing. Rows outside the rule are returned untouched. */
export function withLockedLevelClock<T extends Record<string, unknown>>(row: T): T {
  if (!isLockedClockFormat(row)) {
    const cap = row.is_pinned === true ? 10 : 8;
    const authored = parseStructure(row.blind_structure);
    if (!authored.some((entry) => (levelMinutes(entry) ?? 0) > cap)) return row;
    const capped = authored.map((entry) => {
      if ((levelMinutes(entry) ?? 0) <= cap) return entry;
      return lockStructureClock([entry], cap)[0];
    });
    return {
      ...row,
      blind_structure: typeof row.blind_structure === 'string' ? JSON.stringify(capped) : capped,
    };
  }
  const authored = parseStructure(row.blind_structure);
  if (authored.length === 0) return row;
  const minutes = lockedLevelMinutes(row);
  const locked = lockStructureClock(authored, minutes);
  const levels = Number(row.late_reg_levels);
  const minutesNow = Number(row.late_reg_mins);
  let lateReg: Record<string, unknown> = {};
  if (Number.isSafeInteger(levels) && levels > 0) {
    let derived = false;
    try {
      derived = minutesNow === mttLateRegistrationMinutes(authored, levels);
    } catch {
      derived = false;
    }
    if (derived) lateReg = { late_reg_mins: mttLateRegistrationMinutes(locked, levels) };
  }
  return {
    ...row,
    blind_structure: typeof row.blind_structure === 'string' ? JSON.stringify(locked) : locked,
    ...mttSpeedColumns(locked),
    ...lateReg,
  };
}
