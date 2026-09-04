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

import { DSS_CLUB_ID, MIDWAY_UNION_ID, shHash } from './StableHand.js';

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
  /**
   * The Free Buy's own ladder, NOT the house turbo.
   *
   * Three of Dan's numbers decide this and they are not compatible with
   * TURBO: 3,000 to start, a 10,000 add-on, and an hour of late registration.
   * The house TURBO is 24 levels and 57 minutes end to end, so at the one-hour
   * mark the big blind is 1,500,000 against a 13,000 stack - zero big blinds,
   * and an add-on worth nothing by the time it can be taken. See
   * BLIND_STRUCTURES.FREE_BUY for the measured comparison.
   */
  blindStructure: 'FREE_BUY';
  /** Seats on the board. Sized so the field's own rebuys and add-ons cover the
   *  guarantee without help: see freeBuyBreakEvenEntrants. */
  maxPlayers: number;
  minPlayers: number;
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
    blindStructure: 'FREE_BUY',
    maxPlayers: 200,
    minPlayers: 10,
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
    blindStructure: 'FREE_BUY',
    maxPlayers: 300,
    minPlayers: 10,
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

/* ------------------------------------------------------------------ */
/* WHEN A SLOT ACTUALLY HAPPENS                                        */
/* ------------------------------------------------------------------ */

/**
 * The slots above are CHICAGO wall-clock hours, and the board they have to
 * land on is stored in UTC. Everything in this section converts between the
 * two, and none of it may reach for getUTCHours(): Chicago is UTC-5 for eight
 * months of the year and UTC-6 for four, so a scheduler that treats 20:00
 * Chicago as a fixed UTC hour moves the feature event to 19:00 every November
 * and back again every March.
 */
const CHICAGO_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface ChicagoParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The Chicago wall clock at a UTC instant. */
export function chicagoParts(ms: number): ChicagoParts {
  const p = Object.fromEntries(
    CHICAGO_PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return {
    year: Number(p.year),
    // hour12:false still renders midnight as "24" in some ICU versions.
    hour: Number(p.hour) % 24,
    month: Number(p.month),
    day: Number(p.day),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** The Chicago calendar day an instant falls in, as YYYY-MM-DD. Half of the
 *  idempotency key: one Free Buy per (host, slot, Chicago date). */
export function chicagoDayKey(ms: number): string {
  const p = chicagoParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Chicago's offset from UTC, in ms, at this instant. Negative all year. */
function chicagoOffsetMs(ms: number): number {
  const p = chicagoParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ms;
}

/**
 * The UTC instant of a Chicago wall-clock hour on a given Chicago date.
 *
 * Two passes, because the offset depends on the answer: the first guess uses
 * the offset at the naive instant, the second re-reads the offset AT that
 * guess and corrects it. That converges for every real instant and is the
 * standard way to do this without a timezone library.
 *
 * Neither DST discontinuity can bite here. The spring-forward gap is
 * 02:00-03:00 and the fall-back repeat is 01:00-02:00; the five Free Buy
 * hours are 00, 08, 12, 16 and 20, so no slot ever lands on a wall-clock time
 * that either does not exist or happens twice.
 */
export function chicagoWallClockToUtcMs(dayKey: string, hour: number): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0);
  const first = naive - chicagoOffsetMs(naive);
  return naive - chicagoOffsetMs(first);
}

/**
 * How far ahead of its start a slot is published.
 *
 * STRICTLY LESS THAN THE FOUR-HOUR CADENCE, and that is the whole reason for
 * the number rather than a taste in lead times: at three hours exactly one
 * Free Buy per host is ever open at once, so two of them can never compete for
 * the same free horses, and the lobby never shows a player two identical free
 * events and asks them to choose.
 *
 * It also clears both windows underneath it. fn_freeroll_fill_targets only
 * looks 90 minutes ahead, and the pre-start ramp's curve is squared over its
 * 72-hour ceiling, so an event published three hours out sits at one entrant
 * until the last hour and then fills - which is the shape the ramp was tuned
 * for. Publishing a whole day ahead would put ten free events on the board at
 * once for no gain; publishing at MTT_PUBLISH_LEAD_MS (30 minutes) would make
 * a scheduled marquee event invisible to anyone not already staring at it.
 */
export const FREE_BUY_PUBLISH_LEAD_MS = 3 * 60 * 60 * 1000;

export interface DueFreeBuy {
  slot: FreeBuySlot;
  /** Chicago calendar date of the slot, YYYY-MM-DD. */
  dayKey: string;
  /** UTC ms the event starts. */
  startMs: number;
}

/**
 * Every slot whose start is inside the publication lead and still ahead of us.
 *
 * A slot already past is NEVER created. An engine that was down over 20:00
 * does not get to publish a tournament that started an hour ago; the next slot
 * is three hours away and the board recovers on its own.
 */
export function freeBuySlotsDue(
  nowMs: number,
  leadMs: number = FREE_BUY_PUBLISH_LEAD_MS
): DueFreeBuy[] {
  const out: DueFreeBuy[] = [];
  // Today AND tomorrow in Chicago: the 00:00 slot belongs to the NEXT calendar
  // day and comes inside the lead at 21:00 the evening before, so a scheduler
  // reading only "today" would never see the midnight event at all.
  const days = new Set([chicagoDayKey(nowMs), chicagoDayKey(nowMs + 24 * 60 * 60 * 1000)]);
  for (const dayKey of days) {
    for (const slot of FREE_BUY_SLOTS) {
      const startMs = chicagoWallClockToUtcMs(dayKey, slot.chicagoHour);
      if (startMs <= nowMs) continue;
      if (startMs - nowMs > leadMs) continue;
      out.push({ slot, dayKey, startMs });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/* ------------------------------------------------------------------ */
/* THE TWO HOSTS                                                       */
/* ------------------------------------------------------------------ */

/**
 * A host is the bucket the whole of Operation Stable Hand counts in, and it is
 * the bucket a Free Buy is created in too.
 *
 * unionId IS NOT COSMETIC AND IS NOT OPTIONAL. fn_ca_fund_overlay_on_lock
 * funds a guarantee from union_wallets when union_id is set and from
 * clubs.chip_treasury when it is not. Midway Union's own treasury holds 0.66
 * chips against a union bank of 66,596, so a Union Free Buy created WITHOUT
 * union_id would draw its overlay from an empty pocket and fail the lock.
 * Deep Stack Society is a standalone club and correctly has no union.
 */
export interface FreeBuyHost {
  hostId: string;
  /** tournaments.club_id */
  clubId: string;
  /** tournaments.union_id, or null for a standalone club. */
  unionId: string | null;
  label: string;
}

/**
 * The two hosts, in the order their boards are filled.
 *
 * Midway Union stamps club_id AND union_id with the union id, which is the
 * shape every house-owned event on this platform has always had and is what
 * routes the overlay to union_wallets. Deep Stack Society is standalone: its
 * union_id is null and its overlay comes from clubs.chip_treasury.
 */
export const FREE_BUY_HOSTS: FreeBuyHost[] = [
  {
    hostId: MIDWAY_UNION_ID,
    clubId: MIDWAY_UNION_ID,
    unionId: MIDWAY_UNION_ID,
    label: 'Midway Union',
  },
  {
    hostId: DSS_CLUB_ID,
    clubId: DSS_CLUB_ID,
    unionId: null,
    label: 'Deep Stack Society',
  },
];

/**
 * Minutes of ladder from level 1 up to and including `level`.
 */
export function ladderMinutesThrough(
  ladder: ReadonlyArray<{ durationMinutes?: number }>,
  level: number
): number {
  let total = 0;
  for (let i = 0; i < Math.min(level, ladder.length); i++) {
    total += Number(ladder[i]?.durationMinutes) || 0;
  }
  return total;
}

/**
 * The level count that comes closest to `minutes` of real clock on this
 * ladder. late_reg_levels is what the engine actually enforces; late_reg_mins
 * is the legacy fallback, and the two disagreeing is how an event advertises
 * an hour of late registration and closes it in twenty minutes.
 *
 * Rounds to the NEAREST level rather than truncating: on a turbo whose levels
 * are 4 minutes decaying to 2, truncation loses most of a level every time.
 * A TIE GOES TO THE SHORTER SIDE (strict `<` on the gap, scanning upward), so
 * an event never runs late registration longer than the hour it advertised.
 */
export function lateRegLevelsForMinutes(
  ladder: ReadonlyArray<{ durationMinutes?: number }>,
  minutes: number
): number {
  if (ladder.length === 0 || minutes <= 0) return 1;
  let best = 1;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let level = 1; level <= ladder.length; level++) {
    const gap = Math.abs(ladderMinutesThrough(ladder, level) - minutes);
    if (gap < bestGap) {
      bestGap = gap;
      best = level;
    }
  }
  return best;
}

/**
 * The entrant count at which a tier's own rebuys and add-ons cover its
 * guarantee, so the house funds no overlay at all. Every entrant takes exactly
 * one add-on (35% at once, the rest at the break) and the field averages
 * `rebuysPerEntrant` rebuys inside the hour.
 */
export function freeBuyBreakEvenEntrants(cfg: FreeBuyConfig, rebuysPerEntrant = 1): number {
  const perEntrant = cfg.addOnCost + rebuysPerEntrant * cfg.rebuyCost;
  if (perEntrant <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(cfg.guarantee / perEntrant);
}

/* ------------------------------------------------------------------ */
/* THE ROW                                                             */
/* ------------------------------------------------------------------ */

/**
 * The `tournaments` row for one scheduled Free Buy. Pure: the caller supplies
 * the house ladders and the seat clamp, so this module still imports nothing
 * that touches a database and the row can be asserted in a unit test.
 *
 * free_buy = true is the marker the tier-aware pricing trigger reads
 * (fn_freerolls_are_free_buy): a scheduled Free Buy that set its own
 * rebuy_cost keeps it, and every other 0-buy-in MTT is still forced to 1.00.
 * Setting the flag WITHOUT setting rebuy_cost would fall through to the same
 * default, which is why both are written here together.
 */
export function freeBuyTournamentRow(opts: {
  host: FreeBuyHost;
  due: DueFreeBuy;
  blindStructure: unknown[];
  payoutStructure: unknown[];
  tableSize: number;
  lateRegLevels: number;
}): Record<string, unknown> {
  const cfg = FREE_BUY_TIERS[opts.due.slot.tier];
  return {
    club_id: opts.host.clubId,
    union_id: opts.host.unionId,
    name: `${opts.due.slot.label} (NLH)`,
    game_type: 'NLH',
    variant: 'freezeout',
    tournament_type: 'MTT',
    // THE FIRST ENTRY IS FREE. Both halves must be 0 or
    // tournaments_free_buy_entry_is_free refuses the row outright.
    buy_in_amount: 0,
    buy_in_fee: 0,
    free_buy: true,
    guaranteed_prize: cfg.guarantee,
    starting_chips: cfg.startingChips,
    max_players: cfg.maxPlayers,
    min_players: cfg.minPlayers,
    table_size: opts.tableSize,
    current_players: 0,
    status: 'REGISTERING',
    blind_structure: opts.blindStructure,
    payout_structure: opts.payoutStructure,
    start_time: new Date(opts.due.startMs).toISOString(),
    late_reg_levels: opts.lateRegLevels,
    late_reg_mins: cfg.lateRegMinutes,
    is_bounty: false,
    is_pko: false,
    is_mystery_bounty: false,
    bounty_amount: 0,
    // Rebuys and re-entries run for exactly as long as late registration.
    is_rebuy: true,
    is_reentry: true,
    rebuy_cost: cfg.rebuyCost,
    rebuy_chips: cfg.rebuyChips,
    rebuy_levels: opts.lateRegLevels,
    // NULL, not 0: process_tournament_rebuy reads a NOT NULL 0 as
    // "Rebuy limit reached (0 of 0)" and denies every rebuy. Dan set the
    // horse allowance at 0-5 and that is enforced in FreeBuy.horseMayRebuy,
    // not by a column that would also cap humans.
    max_rebuys: null,
    max_reentries: null,
    // ONE add-on, in ONE window that opens at sit-down and closes after the
    // break. addon_from_start is what moves the opening to the start; without
    // it the engine opens 60 seconds of add-on once late reg closes and Dan's
    // "as soon as they sit down" half of the rule never happens.
    add_on_available: true,
    addon_from_start: true,
    addon_cost: cfg.addOnCost,
    addon_chips: cfg.addOnChips,
    addon_levels: 1,
  };
}
