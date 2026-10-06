/**
 * ═══ THE DIAMOND CASH HAND IS PRICED BY ITS SETTINGS ═════════════════════
 *
 * The settler recomputes the rake from the owner's published economics and
 * refuses the hand by name when the engine's number differs
 * (`diamond_cash_rake_disagrees`). Until this module existed the engine had no
 * Diamond pricer at all: `calculateRake` reads the CHIP schedule in
 * config/rakeSpec.ts, a Diamond table's `rake_percent` and `rake_cap_bb`
 * columns are required to be explicitly zero by DiamondCashBoundary, and so
 * every Diamond cash hand declared `rake: 0`. Every hand whose published
 * schedule rakes anything therefore refused, and the Diamond cash felt could
 * not open.
 *
 * ONE ARITHMETIC, TWO READERS. The expression below is
 * `fn_poker_diamond_settle_cash_hand`'s, transcribed:
 *
 *     v_dealt_key := CASE WHEN v_dealt <= 2 THEN '_heads_up'
 *                         WHEN v_dealt = 3 THEN '_three_handed'
 *                         ELSE '' END;
 *     v_expected := CASE
 *       WHEN v_dealt < 2 THEN 0
 *       WHEN NOT v_saw_flop AND v_no_drop THEN 0
 *       WHEN v_pot < v_min_pot THEN 0
 *       ELSE least(trunc(v_pot::numeric * v_pct / 100), v_cap)::bigint END;
 *
 * It is not "the same rule in spirit": a Diamond of difference refuses the
 * hand, so the branch order, the bracket boundaries, the truncation and the
 * cap's position after the truncation are all exact.
 *
 * NO NUMBER LIVES HERE. Not a percent, not a cap, not a rung of the stake
 * ladder. Every one arrives in `DiamondCashRakeSchedule`, read from
 * `ca_diamond_economics` by services/supabase/diamondCashRakeSettings.ts. The
 * owner changes any answer with one INSERT and no code moves. The only
 * constants in this file are the two that define the words themselves - a
 * percent is per hundred, and a decimal digit is worth ten of the next - and
 * `tests/the-diamond-cash-rake-is-priced-by-its-settings.law.test.ts` holds
 * that line.
 *
 * EXACT DECIMAL ARITHMETIC, NOT FLOATING POINT. PostgreSQL computes
 * `pot * pct / 100` in `numeric`, which is exact decimal. IEEE 754 is not:
 * a percent of 10.1 is not representable, and one unit of drift across the
 * truncation boundary is a refused hand. Every value is therefore carried as
 * an exact scaled integer (`units / 10^scale`) and every operation is BigInt,
 * so the engine's number is the settler's number by construction rather than
 * by luck.
 *
 * HORSES ARE PLAYERS (CLAUDE.md 10.5). There is no seat, user, horse or human
 * in this module's inputs. It is handed a pot, a count of players dealt in, a
 * flop fact and the published schedule, so a horse's seat is priced by the
 * same percent, the same cap and the same bracket as a person's - not by a
 * matching branch, but because no branch exists that could tell them apart.
 */

/** Anything the published settings say that this engine cannot honour. */
export class DiamondCashRakeSettingRefusal extends Error {}

/**
 * An exact non-negative decimal, as `units / 10^scale`.
 *
 * A Diamond does not divide, but a PERCENT and a CAP are numeric columns and
 * the owner may publish a fractional one. Carrying them exactly is what lets
 * this module mirror `numeric` rather than approximate it.
 */
export interface ExactDecimal {
  readonly units: bigint;
  readonly scale: number;
}

/** A percent is per hundred. This is the word's definition, not a rate. */
const PER_CENT = 100n;
/** A decimal digit is worth ten of the next. Likewise. */
const RADIX = 10n;

function pow10(scale: number): bigint {
  return RADIX ** BigInt(scale);
}

/**
 * The most significant digits a published answer may carry.
 *
 * `ca_diamond_economics.value` is `numeric`, and the engine receives it as a
 * JSON number whose shortest round-trip decimal is the stored decimal for any
 * value of at most this many significant digits. Beyond that the two can
 * differ, the settler would compute on the stored decimal and the engine on
 * another, and the hand would refuse. A longer answer is therefore REFUSED
 * rather than priced: an economics row this engine cannot read exactly is a
 * row it must not guess at.
 */
const MAX_SIGNIFICANT_DIGITS = 15;

/**
 * Parse a published answer into an exact decimal, or refuse it by name.
 *
 * Accepts only plain decimal notation. Exponential notation, a sign, an
 * empty fraction and anything non-numeric are refused: each would mean the
 * engine is reading something other than what was published.
 */
export function exactDecimalFromSetting(name: string, raw: unknown): ExactDecimal {
  const text =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : null;
  if (text === null || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_economics_unreadable:${name} (${JSON.stringify(raw)})`
    );
  }
  const [whole, fraction = ''] = text.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '');
  if (digits.length > MAX_SIGNIFICANT_DIGITS) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_economics_unreadable:${name} (too many significant digits)`
    );
  }
  return { units: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

/** `a < b`, on two exact decimals, without leaving the integers. */
function lessThan(a: ExactDecimal, b: ExactDecimal): boolean {
  return a.units * pow10(b.scale) < b.units * pow10(a.scale);
}

/**
 * `value::bigint`, as PostgreSQL casts it: half away from zero.
 *
 * Only reachable when a CAP is the binding term AND that cap is fractional,
 * because `trunc()` has already made the percent term a whole number. The
 * owner's published caps are whole Diamonds (the one rung that halves, the
 * heads-up cap at bb:5, was published as 37 rather than 37.5), so this is the
 * settler's behaviour written down rather than a rounding this engine wants.
 * Mirroring it is what keeps the two numbers equal if a fractional cap is
 * ever published; `cash_rake_rounding` still governs the percent term and
 * only `down` is honoured.
 */
function castToWhole(value: ExactDecimal): bigint {
  if (value.scale === 0) return value.units;
  const denominator = pow10(value.scale);
  return (value.units * 2n + denominator) / (denominator * 2n);
}

/**
 * The owner's published Diamond cash rake schedule, resolved for ONE table's
 * stake and frozen for ONE hand.
 *
 * Every field is a row. `bigBlind` is the stake the three caps were read at
 * (scope `bb:<big blind>`), carried so a schedule can never be applied at a
 * stake it was not read for.
 *
 * THE SWITCH IS AN ANSWER, SO IT IS THE DISCRIMINANT. `cash_rake_enabled`
 * reading off - or being absent, which the settler treats as the same answer -
 * means the amount is exactly zero, and the settler then reads no percent, no
 * cap, no minimum and no rounding at all. So an off schedule HOLDS none of
 * them: requiring a cap rung to be published before a table whose rake is
 * switched off may deal would refuse hands over numbers nothing was going to
 * read.
 */
export type DiamondCashRakeSchedule =
  | {
      readonly enabled: false;
      readonly bigBlind: number;
    }
  | {
      readonly enabled: true;
      readonly bigBlind: number;
      readonly noFlopNoDrop: boolean;
      readonly rounding: string;
      readonly minPot: ExactDecimal;
      /** Indexed by the settler's own bracket suffix. */
      readonly percent: Readonly<Record<DiamondRakeBracket, ExactDecimal>>;
      readonly cap: Readonly<Record<DiamondRakeBracket, ExactDecimal>>;
    };

/**
 * The settler's dealt-in bracket, named by the SUFFIX it appends to the
 * setting name. The empty string is the four-or-more bracket, whose settings
 * carry no suffix at all - `cash_rake_percent`, `cash_rake_cap`.
 */
export type DiamondRakeBracket = '_heads_up' | '_three_handed' | '';

export const DIAMOND_RAKE_BRACKETS: readonly DiamondRakeBracket[] = [
  '_heads_up',
  '_three_handed',
  '',
];

/**
 * Which bracket a count of players dealt in falls in.
 *
 * `v_dealt <= 2 THEN '_heads_up' WHEN v_dealt = 3 THEN '_three_handed' ELSE ''`
 * - transcribed, including that the heads-up arm catches every count BELOW
 * two as well. The pricer answers zero for those before any percent is read,
 * exactly as the settler's first CASE arm does.
 */
export function diamondRakeBracketFor(dealtIn: number): DiamondRakeBracket {
  if (dealtIn <= 2) return '_heads_up';
  if (dealtIn === 3) return '_three_handed';
  return '';
}

/** The three facts the settler recomputes from, and nothing else. */
export interface DiamondCashRakeFactsForPricing {
  /** Whole Diamonds in the pot: the sum of every seat's `contributed`. */
  readonly pot: number;
  /** How many seats were dealt a hand: the count of `dealt_in`. */
  readonly dealtIn: number;
  /** Whether a flop was dealt: the hand's own `hand_saw_flop`. */
  readonly sawFlop: boolean;
}

/**
 * The rake, in whole indivisible Diamonds, that the owner's settings price
 * this hand at - which is the number the settler will recompute and the only
 * number it will accept.
 */
export function priceDiamondCashRake(
  schedule: DiamondCashRakeSchedule,
  facts: DiamondCashRakeFactsForPricing
): number {
  /* THE SWITCH IS AN ANSWER. Off means the amount is exactly zero, which is
     the same thing the settler's `NOT v_rake_on` arm says. */
  if (!schedule.enabled) return 0;

  /* Only `down` is implemented, and the refusal names the value it cannot
     apply - the settler's words, so an unhonourable answer reads the same
     whichever side of the wire finds it first. Checked BEFORE the zero
     branches, as the settler checks it before its own CASE, so a hand this
     engine cannot price is refused rather than quietly raked nothing. */
  if (schedule.rounding !== 'down') {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_cash_rake_rounding_unsupported:${schedule.rounding}`
    );
  }

  if (!Number.isSafeInteger(facts.pot) || facts.pot < 0) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_cash_rake_pot_must_be_whole_diamonds:${facts.pot}`
    );
  }
  if (!Number.isSafeInteger(facts.dealtIn) || facts.dealtIn < 0) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_cash_rake_dealt_count_invalid:${facts.dealtIn}`
    );
  }

  if (facts.dealtIn < 2) return 0;
  if (!facts.sawFlop && schedule.noFlopNoDrop) return 0;

  const pot: ExactDecimal = { units: BigInt(facts.pot), scale: 0 };
  if (lessThan(pot, schedule.minPot)) return 0;

  const bracket = diamondRakeBracketFor(facts.dealtIn);
  const percent = schedule.percent[bracket];
  const cap = schedule.cap[bracket];

  /* trunc(pot * pct / 100). Every term is a non-negative integer, so BigInt
     division truncates exactly where `trunc()` does. */
  const truncated = (pot.units * percent.units) / (pow10(percent.scale) * PER_CENT);
  /* least(..., cap) - the cap applies AFTER the truncation, never before. */
  const rake = lessThan(cap, { units: truncated, scale: 0 }) ? castToWhole(cap) : truncated;

  /* A rake larger than the pot is a defect, not a number to publish: the
     settler refuses one (`diamond_cash_rake_facts_disagree`) and so does
     this. Reachable only from a published cap or percent that says so. */
  if (rake > pot.units) {
    throw new DiamondCashRakeSettingRefusal(
      `diamond_cash_rake_exceeds_the_pot:${rake} of ${facts.pot}`
    );
  }
  return Number(rake);
}

/**
 * ═══ THE PUBLISHED ROWS, RESOLVED ════════════════════════════════════════
 *
 * `fn_ca_diamond_economic` resolves a name and scope as
 *
 *     SELECT e.value FROM public.ca_diamond_economics e
 *      WHERE e.name = p_name AND e.scope = COALESCE(p_scope,'all')
 *      ORDER BY e.recorded_at DESC, e.id DESC
 *      LIMIT 1;
 *     IF v_value IS NULL THEN RAISE 'diamond_economics_unset:<name>/<scope>'
 *
 * and the table is append-only, so "the newest row wins" is how a changed
 * answer takes effect. That rule is mirrored below EXACTLY, including the two
 * parts that are easy to get subtly wrong and would be invisible until the
 * owner changed something:
 *
 *   - the newest row wins even if its value is NULL. It does NOT fall through
 *     to an older row. A name whose latest row is blank is UNSET, and unset is
 *     a refusal rather than a zero.
 *   - no scope ever falls back to another. A stake with no published cap rung
 *     refuses by name instead of being raked at some other stake's cap.
 *
 * The mirror is held in place from both sides: a law test pins this rule
 * against the applied migration's own source, and
 * scripts/dev/probe-diamond-cash-rake-facts-pg17.sh compares this resolution
 * against `fn_ca_diamond_economic`'s own answers, name by name, in a
 * disposable database - including a superseded answer and a blanked one.
 *
 * PURE, AND DELIBERATELY SO. No database client is imported here, which is
 * what lets the probe run the engine's own pricer as a script and compare its
 * number with the settler's for the same hand.
 */

/** The settings this schedule is made of. Scopes are assigned per name below. */
const NUMERIC_NAMES = ['cash_rake_min_pot'] as const;
const WORD_NAMES = [
  'cash_rake_enabled',
  'cash_rake_no_flop_no_drop',
  'cash_rake_rounding',
] as const;
/** Read at scope 'all', once per bracket suffix. */
const BRACKET_PERCENT = 'cash_rake_percent';
/** Read at scope 'bb:<big blind>', once per bracket suffix. */
const BRACKET_CAP = 'cash_rake_cap';

/** One row of `ca_diamond_economics`, as the reader orders and reads them. */
export interface EconomicsRow {
  name: string;
  scope: string;
  value: number | string | null;
  value_text: string | null;
  recorded_at: string | null;
  id: number;
}

/** 'all' or '^bb:[0-9]+$' - the settings table's whole scope grammar. */
export function diamondCashRakeStakeScope(bigBlind: number): string {
  if (!Number.isSafeInteger(bigBlind) || bigBlind <= 0) {
    throw new DiamondCashRakeSettingRefusal(`diamond_cash_rake_requires_a_whole_stake:${bigBlind}`);
  }
  return `bb:${bigBlind}`;
}

/** Every name this schedule needs, so one query fetches all of them. */
export function diamondCashRakeSettingNames(): string[] {
  return [
    ...NUMERIC_NAMES,
    ...WORD_NAMES,
    ...DIAMOND_RAKE_BRACKETS.map((bracket) => `${BRACKET_PERCENT}${bracket}`),
    ...DIAMOND_RAKE_BRACKETS.map((bracket) => `${BRACKET_CAP}${bracket}`),
  ];
}

/**
 * The newest row for one name and scope, by the reader's own ordering.
 *
 * Returns the ROW, not the value, so the caller can apply the reader's
 * "the newest row's blank value is unset" rule rather than skipping past it.
 */
function newestRow(
  rows: readonly EconomicsRow[],
  name: string,
  scope: string
): EconomicsRow | null {
  let best: EconomicsRow | null = null;
  for (const row of rows) {
    if (row.name !== name || row.scope !== scope) continue;
    if (best === null) {
      best = row;
      continue;
    }
    const at = Date.parse(String(row.recorded_at ?? ''));
    const bestAt = Date.parse(String(best.recorded_at ?? ''));
    /* ORDER BY recorded_at DESC, id DESC. A row with no timestamp cannot be
       ordered against one that has it, so it never wins: guessing its place
       would silently pick an answer the reader would not have picked. */
    if (!Number.isFinite(at)) continue;
    if (!Number.isFinite(bestAt) || at > bestAt || (at === bestAt && row.id > best.id)) best = row;
  }
  return best;
}

function unset(name: string, scope: string): never {
  throw new DiamondCashRakeSettingRefusal(`diamond_economics_unset:${name}/${scope}`);
}

function readNumber(rows: readonly EconomicsRow[], name: string, scope: string): ExactDecimal {
  const row = newestRow(rows, name, scope);
  if (!row || row.value === null) unset(name, scope);
  return exactDecimalFromSetting(`${name}/${scope}`, row.value);
}

function readWord(rows: readonly EconomicsRow[], name: string, scope: string): string {
  const row = newestRow(rows, name, scope);
  if (!row || row.value_text === null) unset(name, scope);
  return row.value_text;
}

/**
 * The switch, read as the settler reads it.
 *
 * `fn_poker_diamond_settle_cash_hand` calls `fn_ca_diamond_economic_on` and
 * catches PDE01 - the UNSET refusal - into `false`, because "switch absent"
 * and "switch off" are one answer (design 3.2). Every other refusal travels.
 * Mirrored exactly: a missing or blank switch row is off, and any OTHER word
 * is off as well, since the reader's own rule is `= 'yes'` and nothing else.
 *
 * ONLY `cash_rake_enabled` IS READ THIS WAY. The settler wraps that one name
 * in the PDE01 handler and no other, so `cash_rake_no_flop_no_drop` unset
 * RAISES out of the settler rather than reading as off. It is therefore read
 * by `requiredSwitch` below, which refuses it the same way.
 */
function absentMeansOff(rows: readonly EconomicsRow[], name: string): boolean {
  const row = newestRow(rows, name, 'all');
  return row?.value_text === ON;
}

/** A boolean answer the settler requires: unset is a refusal, never an off. */
function requiredSwitch(rows: readonly EconomicsRow[], name: string): boolean {
  return readWord(rows, name, 'all') === ON;
}

/** `fn_ca_diamond_economic_on`: a switch is on when its word is exactly 'yes'. */
const ON = 'yes';

/**
 * The published schedule for one Diamond cash table's stake.
 *
 * Throws `DiamondCashRakeSettingRefusal` when any answer this engine needs is
 * unset, unreadable or at a scope that was never published. It never returns a
 * partial schedule and never substitutes a number of its own.
 */
/**
 * The published rows, resolved into one stake's schedule.
 *
 * Separate from the query so the RESOLUTION RULE can be driven directly by
 * rows - a superseded answer, a blanked one, a stake with no rung - which is
 * the half of this module that can be wrong without the query ever failing.
 */
export function resolveDiamondCashRakeSchedule(
  rows: readonly EconomicsRow[],
  bigBlind: number
): DiamondCashRakeSchedule {
  const scope = diamondCashRakeStakeScope(bigBlind);

  /* THE SWITCH FIRST. With it off the settler reads nothing else and prices
     exactly zero, so nothing else is required to deal. */
  if (!absentMeansOff(rows, 'cash_rake_enabled'))
    return Object.freeze({ enabled: false, bigBlind });

  const percent: Record<DiamondRakeBracket, ExactDecimal> = {} as never;
  const cap: Record<DiamondRakeBracket, ExactDecimal> = {} as never;
  for (const bracket of DIAMOND_RAKE_BRACKETS) {
    percent[bracket] = readNumber(rows, `${BRACKET_PERCENT}${bracket}`, 'all');
    cap[bracket] = readNumber(rows, `${BRACKET_CAP}${bracket}`, scope);
  }
  return Object.freeze({
    bigBlind,
    enabled: true,
    noFlopNoDrop: requiredSwitch(rows, 'cash_rake_no_flop_no_drop'),
    rounding: readWord(rows, 'cash_rake_rounding', 'all'),
    minPot: readNumber(rows, 'cash_rake_min_pot', 'all'),
    percent: Object.freeze(percent),
    cap: Object.freeze(cap),
  });
}
