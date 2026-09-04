/**
 * FREE BUY TOURNAMENTS - Dan 2026-09-04.
 *
 * "YOUR FIRST BUY IN IS FREE, 3000 CHIPS STARTING STACK ... PLAYERS CAN ADD ON
 *  AS SOON AS THEY SIT DOWN, AND ALSO AT THE BREAK. ADD ON GETS 10,000 CHIPS."
 *
 * A Free Buy is NOT a freeroll. A freeroll is free and stays free; a Free Buy
 * gives away the first entry and sells rebuys and add-ons, so it earns. That
 * distinction matters for the guarantee: the headline number is a CEILING on
 * house exposure, not a cost, because every rebuy and add-on paid at the table
 * goes into the same prize pool and the house only funds the shortfall.
 *
 * Pure module: no clock, no IO, no randomness. Horse behaviour is a sha256 of
 * (horse, event), so the same horse makes the same choice every time the
 * question is asked - a re-evaluated tick cannot produce a different field.
 */

import { shHash } from './StableHand.js';

/* ------------------------------------------------------------------ */
/* The two tiers                                                       */
/* ------------------------------------------------------------------ */

export type FreeBuyTier = 'standard' | 'feature';

export interface FreeBuyConfig {
  tier: FreeBuyTier;
  guarantee: number;
  /** The first entry. Free, by definition - this is what makes it a Free Buy. */
  buyIn: 0;
  startingChips: number;
  rebuyCost: number;
  rebuyChips: number;
  addOnCost: number;
  addOnChips: number;
  lateRegMinutes: number;
  blindStructure: 'TURBO';
}

/** Dan 2026-09-04: "$250 FREE BUY IS $1 REBUY AND $1 ADD ON ... FOR THE $500
 *  REBUYS ARE $2 AND ADD ON'S $2." Starting stack 3,000; an add-on is 10,000,
 *  so an add-on is worth more than three starting stacks and is close to
 *  compulsory - which is exactly why every horse takes one. */
export const FREE_BUY_TIERS: Record<FreeBuyTier, FreeBuyConfig> = {
  standard: {
    tier: 'standard',
    guarantee: 250,
    buyIn: 0,
    startingChips: 3000,
    rebuyCost: 1,
    rebuyChips: 3000,
    addOnCost: 1,
    addOnChips: 10000,
    lateRegMinutes: 60,
    blindStructure: 'TURBO',
  },
  feature: {
    tier: 'feature',
    guarantee: 500,
    buyIn: 0,
    startingChips: 3000,
    rebuyCost: 2,
    rebuyChips: 3000,
    addOnCost: 2,
    addOnChips: 10000,
    lateRegMinutes: 60,
    blindStructure: 'TURBO',
  },
};

/* ------------------------------------------------------------------ */
/* The daily schedule                                                  */
/* ------------------------------------------------------------------ */

export interface FreeBuySlot {
  /** America/Chicago hour. */
  chicagoHour: number;
  tier: FreeBuyTier;
  label: string;
}

/** Dan: "EVERY 4 HOURS STARTING AT 8 AM, 12PM, 4PM 8PM, 12AM. SO 5 FREE ROLLS
 *  A DAY $250'S EACH. 8PM IS $500."
 *
 *  These are CHICAGO hours, not UTC. The existing recurring board matches on
 *  `getUTCHours()`, which would drift by an hour twice a year and quietly move
 *  the 8PM feature event to 7PM every November. */
export const FREE_BUY_SLOTS: FreeBuySlot[] = [
  { chicagoHour: 8, tier: 'standard', label: 'Morning Free Buy' },
  { chicagoHour: 12, tier: 'standard', label: 'Midday Free Buy' },
  { chicagoHour: 16, tier: 'standard', label: 'Afternoon Free Buy' },
  { chicagoHour: 20, tier: 'feature', label: 'Prime Time Free Buy' },
  { chicagoHour: 0, tier: 'standard', label: 'Midnight Free Buy' },
];

export function slotForChicagoHour(hour: number): FreeBuySlot | null {
  return FREE_BUY_SLOTS.find((s) => s.chicagoHour === hour) ?? null;
}

/** Guarantee exposure per host per day. 4 x 250 + 500 = 1,500. */
export function dailyGuaranteePerHost(): number {
  return FREE_BUY_SLOTS.reduce((sum, s) => sum + FREE_BUY_TIERS[s.tier].guarantee, 0);
}

/** A Free Buy's prize pool is fed by rebuys and add-ons, so the house only
 *  funds the SHORTFALL. This is the number that actually leaves the treasury. */
export function overlayFor(guarantee: number, collected: number): number {
  return Math.max(0, guarantee - collected);
}

/* ------------------------------------------------------------------ */
/* The add-on window                                                   */
/* ------------------------------------------------------------------ */

/**
 * Dan: add on "AS SOON AS THEY SIT DOWN, AND ALSO AT THE BREAK", and
 * "ONE HOUR FOR LATE REG, THEN THE ADD ON PERIOD."
 *
 * Read together those are not two windows, they are ONE window that opens when
 * the event starts and closes when the add-on break ends. A player may take
 * their single add-on at any point inside it - immediately, or at the break.
 * Modelling it as two windows would need a second add-on slot per player and
 * would break `tournament_players.add_on`, which is a boolean.
 *
 * The engine's normal behaviour is the opposite: the window opens for 60
 * seconds once late registration closes. Free Buy sets `addon_from_start`, and
 * that flag is the only thing that changes.
 */
export interface AddOnWindow {
  opensAtMs: number;
  closesAtMs: number;
}

export const ADDON_BREAK_MS = 60_000;

export function addOnWindowFor(startMs: number, cfg: FreeBuyConfig): AddOnWindow {
  return {
    opensAtMs: startMs,
    closesAtMs: startMs + cfg.lateRegMinutes * 60_000 + ADDON_BREAK_MS,
  };
}

export function addOnOpen(nowMs: number, w: AddOnWindow): boolean {
  return nowMs >= w.opensAtMs && nowMs < w.closesAtMs;
}

/** Late registration and the rebuy period end together, one hour in. */
export function rebuysOpen(nowMs: number, startMs: number, cfg: FreeBuyConfig): boolean {
  return nowMs < startMs + cfg.lateRegMinutes * 60_000;
}

/* ------------------------------------------------------------------ */
/* Horse behaviour                                                     */
/* ------------------------------------------------------------------ */

/** Dan: "HORSES ALWAYS ADD ON, 35% RIGHT AWAY, 100% OF THE HORSES STILL IN
 *  WHEN REBUYS ARE OVER." One add-on each; the split is only about WHEN. */
export const HORSE_ADDON_IMMEDIATE_RATE = 0.35;

export function horseAddsOnImmediately(horseId: string, eventId: string): boolean {
  return shHash(horseId, eventId, 'addon-immediate') % 1000 < HORSE_ADDON_IMMEDIATE_RATE * 1000;
}

export type AddOnTiming = 'immediate' | 'at_break' | 'busted_before_break';

/**
 * When this horse takes its add-on. Every horse still alive when the rebuy
 * period closes takes one, so the only horses that never add on are the ones
 * already out - and a horse that is out has nothing to add on to.
 */
export function horseAddOnTiming(
  horseId: string,
  eventId: string,
  aliveAtBreak: boolean
): AddOnTiming {
  if (horseAddsOnImmediately(horseId, eventId)) return 'immediate';
  return aliveAtBreak ? 'at_break' : 'busted_before_break';
}

/** Dan: "HORSES REBUY BACK INTO THE EVENT RANDOMLY 0-5 TIMES." Deterministic
 *  per (horse, event) so the same horse does not get a different allowance
 *  each time the engine asks. */
export const HORSE_MAX_REBUYS = 5;

export function horseRebuyAllowance(horseId: string, eventId: string): number {
  return shHash(horseId, eventId, 'rebuy-allowance') % (HORSE_MAX_REBUYS + 1); // 0..5
}

export function horseMayRebuy(opts: {
  horseId: string;
  eventId: string;
  rebuysTaken: number;
  nowMs: number;
  startMs: number;
  cfg: FreeBuyConfig;
  available: number;
}): boolean {
  if (!rebuysOpen(opts.nowMs, opts.startMs, opts.cfg)) return false;
  if (opts.rebuysTaken >= horseRebuyAllowance(opts.horseId, opts.eventId)) return false;
  // Never spend chips a wallet does not have. Free Buy is free to ENTER; a
  // rebuy is real money out of the club wallet like any other.
  return opts.available >= opts.cfg.rebuyCost;
}

/** What the whole field is expected to contribute, for overlay forecasting. */
export function projectedCollected(opts: {
  entrants: number;
  expectedRebuysPerEntrant: number;
  addOnRate: number;
  cfg: FreeBuyConfig;
}): number {
  const rebuys = opts.entrants * opts.expectedRebuysPerEntrant * opts.cfg.rebuyCost;
  const addOns = opts.entrants * opts.addOnRate * opts.cfg.addOnCost;
  return Math.round((rebuys + addOns) * 100) / 100;
}
