/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW: ONE RAKE SPEC - the engine and the database price every pot the same
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Chip Accounting Standard R7 (docs/CHIP-ACCOUNTING-STANDARD.md 3.3), Lane C,
 * 2026-09-02. Registered in docs/LAWS.md.
 *
 * Three things are pinned here, and each one is a way the spec split before:
 *
 *   1. PARITY. `calculateRake` (the money path: PokerEngine, fed by
 *      getFullRakeConfig + getPlayerCountCaps exactly as
 *      ServerTableEngineBase.getRakeConfig feeds it) equals an INDEPENDENT
 *      re-implementation of the SQL `fn_effective_rake` written below in
 *      integer arithmetic (Postgres `numeric` semantics: exact decimals,
 *      round half away from zero), over 500 deterministic cases covering
 *      every scheduled stake, the tier-priced 3.00, an unscheduled stake,
 *      pots from a walk to a nosebleed, 2..9 dealt, flop and no flop, and
 *      owner overrides. `effectiveRake` (rakeSpec.ts, the TS twin the SQL was
 *      written from) is held to the same table. The BBJ drop is pinned the
 *      same way against `fn_effective_bbj_drop`.
 *
 *   2. THE CHECKSUM. `rakeSpecChecksum()` equals the value the migration
 *      asserts (`c_expected`), read from the migration file so the two cannot
 *      be edited apart, and equals the value production returned from
 *      `select fn_rake_spec_checksum()` when this law was written.
 *
 *   3. THE CANONICAL RULE. The keys, their order, and the number formatting
 *      of `rakeSpecCanonical()` match the rule written in both
 *      fn_rake_spec_canonical() and rakeSpec.ts. The SQL builds its text with
 *      format() strings; those literal key sequences are pinned here so a
 *      reordered key on either side turns this red before the checksum can
 *      drift silently.
 *
 * NEGATIVE CONTROLS (run 2026-09-02, both restored to green):
 *   - the 1/2 row's rakeCap changed 5 -> 5.5 in rakeSpec.ts: the checksum
 *     pin went red (80baa7f8... vs 24f57183...) and the known-answers pin
 *     went red (HU cap 2.75 vs 2.50). The 500-case table stayed green, which
 *     is correct: it compares the two arithmetics over the SAME spec; the
 *     checksum is what catches a spec edited on one side.
 *   - calculateRake's final `Math.min(rake, cap)` changed to `cap + 0.01`:
 *     104 of the 500 cases went red (every capped pot). That is the table
 *     doing its job on the arithmetic.
 *
 * If this goes red you have changed the rake spec on one side only. Change
 * rakeSpec.ts, the migration's ca_rake_* rows/rules and the pinned checksum
 * together, in one PR, or a live drift alert will follow the deploy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { calculateRake } from './PokerEngine.js';
import {
  getFullRakeConfig,
  getPlayerCountCaps,
  calculateBBJFee,
  RAKE_SCHEDULE,
  type RakeOverride,
} from '../config/RakeConfig.js';
import {
  RAKE_SPEC,
  effectiveRake,
  effectiveBbjDrop,
  rakeSpecCanonical,
  rakeSpecChecksum,
} from '../config/rakeSpec.js';

// ─────────────────────────────────────────────────────────────────────────────
// The value production returned on 2026-09-02 18:2x UTC from
//   select public.fn_rake_spec_checksum();
// and the value the migration's post-apply assertion pins as c_expected.
// ─────────────────────────────────────────────────────────────────────────────
const PRODUCTION_CHECKSUM_2026_09_02 = '24f571834759564ce7929c33e50bb983';
const MIGRATION = join(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '20260902173200_one_rake_spec_read_by_engine_and_database.sql'
);

// ─────────────────────────────────────────────────────────────────────────────
// NUMERIC: exact decimal arithmetic on integers, so this mirror shares no
// floating-point behaviour with the engine it is checking. Money is held in
// MILLI-CENTS (1/1000 of a cent) which is exact for every value here: two-
// decimal pots and caps, factors 0.5 / 0.67, half-BB override steps.
// ─────────────────────────────────────────────────────────────────────────────
const SCALE = 100_000; // 1.00 chip = 100000
const toN = (chips: number): number => Math.round(chips * SCALE);
const fromN = (n: number): number => n / SCALE;
/** Postgres round(x, 2) on a positive numeric: half away from zero. */
const roundCents = (n: number): number => {
  const unit = SCALE / 100;
  return Math.floor((n + unit / 2) / unit) * unit;
};
/** Postgres round(x, 0). */
const roundWhole = (n: number): number => Math.floor((n + SCALE / 2) / SCALE) * SCALE;
/** numeric multiply of a money value by a factor with <= 2 decimals. */
const mulFactor = (n: number, factor: number): number => Math.round(n * factor);

interface SqlRules {
  headsUpPercent: number;
  headsUpCapFactor: number;
  shortHandedCapFactor: number;
  shortHandedMaxPlayers: number;
  noFlopNoDrop: boolean;
  bbjMinPlayersDealt: number;
  maxRakePercent: number;
  maxRakeCapBB: number;
  bbjIneligibleVariants: readonly string[];
}
const rules: SqlRules = RAKE_SPEC.rules;

/** fn_unscheduled_cap_bb(): max(rake_cap / bb) over the mirror rows. */
function sqlUnscheduledCapBB(): number {
  return RAKE_SCHEDULE.reduce((w, r) => (r.bb > 0 ? Math.max(w, r.rakeCap / r.bb) : w), 0);
}

/** fn_rake_tier_price(p_bb): first tier by max_bb whose max_bb is null or >= bb. */
function sqlTierPrice(bb: number): { pct: number; capN: number; bbjFeeBB: number } {
  const tiers = RAKE_SPEC.tierOrder
    .map((k) => RAKE_SPEC.tiers[k])
    .sort((a, b) => {
      const am = Number.isFinite(a.maxBB) ? a.maxBB : Number.POSITIVE_INFINITY;
      const bm = Number.isFinite(b.maxBB) ? b.maxBB : Number.POSITIVE_INFINITY;
      return am - bm;
    });
  const t = tiers.find((x) => !Number.isFinite(x.maxBB) || bb <= x.maxBB)!;
  const capN =
    bb > 0 ? Math.min(toN(t.rakeCap), roundCents(toN(bb * sqlUnscheduledCapBB()))) : toN(t.rakeCap);
  return { pct: t.rakePercent, capN, bbjFeeBB: t.bbjFeeBB };
}

/** fn_rake_stake_price(p_bb, p_sb): the engine_mirror schedule row, or null. */
function sqlStakePrice(bb: number, sb: number | null) {
  const rows = RAKE_SCHEDULE.filter(
    (r) => Math.abs(r.bb - bb) < 0.001 && (sb === null || Math.abs(r.sb - sb) < 0.001)
  ).sort((a, b) => a.sb - b.sb);
  const r = rows[0];
  return r ? { pct: r.rakePercent, capN: toN(r.rakeCap), bbjFeeBB: r.bbjFeeBB } : null;
}

/** fn_rake_cap_for_dealt(full_cap, dealt). */
function sqlCapForDealt(fullN: number, dealt: number): number {
  if (dealt >= rules.shortHandedMaxPlayers + 1) return fullN;
  if (dealt >= rules.shortHandedMaxPlayers)
    return roundCents(mulFactor(fullN, rules.shortHandedCapFactor));
  if (dealt >= 2) return roundCents(mulFactor(fullN, rules.headsUpCapFactor));
  return fullN;
}

/** ca_rake_schedule_caps: the materialised ladder (source = 'schedule' rows). */
function sqlScheduleCapsLookup(bb: number, key: 2 | 3 | 4): number | null {
  const row = RAKE_SCHEDULE.find((r) => Math.abs(r.bb - bb) < 0.001);
  if (!row) return null;
  return sqlCapForDealt(toN(row.rakeCap), key);
}

/**
 * fn_effective_rake(p_bb, p_pot, p_players_dealt, p_saw_flop, p_sb,
 *                   p_override_percent, p_override_cap_bb) -> rake
 * Transcribed statement by statement from the migration.
 */
function sqlEffectiveRake(
  bb: number,
  pot: number,
  dealt: number,
  sawFlop: boolean,
  sb: number | null,
  ovPct: number | null,
  ovCapBB: number | null
): { rake: number; cap: number; percent: number } {
  let pct: number;
  let fullN: number;
  let scheduled = false;
  const sp = sqlStakePrice(bb, sb);
  if (sp) {
    pct = sp.pct;
    fullN = sp.capN;
    scheduled = true;
  } else {
    const tp = sqlTierPrice(bb);
    pct = tp.pct;
    fullN = tp.capN;
  }
  let capOverridden = false;
  if (ovPct !== null && ovPct >= 0)
    pct = Math.min(Math.min(Math.max(ovPct, 0), rules.maxRakePercent), pct);
  if (ovCapBB !== null && ovCapBB >= 0) {
    const ov = Math.min(Math.max(ovCapBB, 0), rules.maxRakeCapBB);
    fullN = Math.min(roundCents(toN(ov * bb)), fullN);
    capOverridden = true;
  }
  if (dealt <= 2) pct = Math.min(pct, rules.headsUpPercent);

  let capN: number | null = null;
  if (scheduled && !capOverridden) {
    const key: 2 | 3 | 4 =
      dealt >= rules.shortHandedMaxPlayers + 1
        ? 4
        : dealt >= rules.shortHandedMaxPlayers
          ? 3
          : dealt >= 2
            ? 2
            : 4;
    capN = sqlScheduleCapsLookup(bb, key);
  }
  if (capN === null) capN = sqlCapForDealt(fullN, dealt);

  if (rules.noFlopNoDrop && !sawFlop) return { rake: 0, cap: fromN(capN), percent: pct };
  // least(round(pot * pct, 0) / 100, cap): pot*pct is exact in milli-cents when pct has <= 2 decimals.
  const rakeN = Math.min(roundWhole(mulFactor(toN(pot), pct)) / 100, capN);
  return { rake: fromN(rakeN), cap: fromN(capN), percent: pct };
}

/** fn_effective_bbj_drop(...) without the table/club lookups (p_table_id NULL). */
function sqlEffectiveBbjDrop(
  bb: number,
  dealt: number,
  sawFlop: boolean,
  variant: string,
  sb: number | null,
  pot: number | null,
  rake: number | null
): number {
  if (rules.bbjIneligibleVariants.includes(variant.toLowerCase())) return 0;
  if (!sawFlop) return 0;
  if (dealt < rules.bbjMinPlayersDealt) return 0;
  const sp = sqlStakePrice(bb, sb);
  const feeBB = sp ? sp.bbjFeeBB : sqlTierPrice(bb).bbjFeeBB;
  let feeN = roundCents(toN(bb * feeBB));
  if (pot !== null && rake !== null && toN(rake) + feeN > toN(pot)) {
    const overN = roundCents(toN(rake) + feeN - toN(pot));
    feeN = overN <= feeN ? roundCents(feeN - overN) : 0;
  }
  return fromN(feeN);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE'S OWN PATH: exactly ServerTableEngineBase.getRakeConfig +
// HandController.priceDeductions (rake leg), nothing re-derived.
// ─────────────────────────────────────────────────────────────────────────────
function engineRake(
  sb: number,
  bb: number,
  pot: number,
  dealt: number,
  sawFlop: boolean,
  override?: RakeOverride
): number {
  const full = getFullRakeConfig(sb, bb, 'nlh', override);
  return calculateRake(
    pot,
    sawFlop,
    {
      percent: full.rakePercent,
      cap: full.rakeCap,
      noFlopNoDrop: true,
      playerCountCaps: getPlayerCountCaps(full.rakeCap),
    },
    dealt
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// THE 500 CASES. Deterministic (a fixed LCG), and coverage is asserted: every
// stake, every dealt count 2..9, both flop values, and the override cases.
// ─────────────────────────────────────────────────────────────────────────────
interface Stake {
  sb: number;
  bb: number;
  note: string;
}
const STAKES: Stake[] = [
  ...RAKE_SCHEDULE.map((r) => ({ sb: r.sb, bb: r.bb, note: 'schedule' })),
  { sb: 1.5, bb: 3, note: 'tier_priced_3.00' }, // dealt live, no schedule row
  { sb: 0.07, bb: 0.15, note: 'unscheduled_nano' }, // pure tier fallback, held to the ladder
  { sb: 6, bb: 12, note: 'unscheduled_high' }, // tier cap 15 vs 12 x 15 BB = 180
];
const POTS = [0.02, 0.37, 1.5, 4.2, 11.11, 18.75, 33.33, 61.3, 149.99, 640.05, 2500, 19999.99];
const OVERRIDES: (RakeOverride | undefined)[] = [
  undefined,
  undefined,
  undefined,
  { rakePercent: 5, rakeCapBB: null },
  { rakePercent: 2.5, rakeCapBB: 1 },
  { rakePercent: null, rakeCapBB: 0.5 },
  { rakePercent: 20, rakeCapBB: 50 }, // absurd: collapses to the schedule
  { rakePercent: -1, rakeCapBB: -1 }, // the inherit sentinel
  { rakePercent: 0, rakeCapBB: 0 }, // a rake-free table
];

interface Case {
  i: number;
  stake: Stake;
  pot: number;
  dealt: number;
  sawFlop: boolean;
  override: RakeOverride | undefined;
}
function buildCases(n: number): Case[] {
  let seed = 20260902;
  const next = (mod: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % mod;
  };
  const cases: Case[] = [];
  for (let i = 0; i < n; i++) {
    // The first STAKES.length x 8 x 2 cases walk the grid so coverage is
    // structural, not probabilistic; the rest sample it.
    const grid = STAKES.length * 8 * 2;
    const stake = i < grid ? STAKES[i % STAKES.length] : STAKES[next(STAKES.length)];
    const dealt = i < grid ? 2 + (Math.floor(i / STAKES.length) % 8) : 2 + next(8);
    const sawFlop = i < grid ? Math.floor(i / (STAKES.length * 8)) % 2 === 0 : next(2) === 0;
    const pot = POTS[next(POTS.length)];
    const override = i < grid ? undefined : OVERRIDES[next(OVERRIDES.length)];
    cases.push({ i, stake, pot, dealt, sawFlop, override });
  }
  return cases;
}
const CASES = buildCases(500);

const ovPct = (o?: RakeOverride): number | null =>
  o &&
  o.rakePercent !== null &&
  o.rakePercent !== undefined &&
  Number.isFinite(o.rakePercent) &&
  o.rakePercent >= 0
    ? o.rakePercent
    : null;
const ovCap = (o?: RakeOverride): number | null =>
  o &&
  o.rakeCapBB !== null &&
  o.rakeCapBB !== undefined &&
  Number.isFinite(o.rakeCapBB) &&
  o.rakeCapBB >= 0
    ? o.rakeCapBB
    : null;

describe('LAW: one rake spec - calculateRake == fn_effective_rake over 500 cases', () => {
  it('the case table is what the law says it is', () => {
    expect(CASES).toHaveLength(500);
    const stakes = new Set(CASES.map((c) => `${c.stake.sb}/${c.stake.bb}`));
    expect(stakes.size).toBe(STAKES.length);
    expect(new Set(CASES.map((c) => c.dealt))).toEqual(new Set([2, 3, 4, 5, 6, 7, 8, 9]));
    expect(new Set(CASES.map((c) => c.sawFlop))).toEqual(new Set([true, false]));
    expect(CASES.filter((c) => c.override && ovPct(c.override) !== null).length).toBeGreaterThan(
      20
    );
    expect(CASES.filter((c) => c.override && ovCap(c.override) !== null).length).toBeGreaterThan(
      20
    );
    expect(CASES.filter((c) => c.stake.note !== 'schedule').length).toBeGreaterThan(30);
  });

  it.each(CASES.map((c) => [c.i, c] as const))('case %i', (_i, c) => {
    const engine = engineRake(c.stake.sb, c.stake.bb, c.pot, c.dealt, c.sawFlop, c.override);
    const sql = sqlEffectiveRake(
      c.stake.bb,
      c.pot,
      c.dealt,
      c.sawFlop,
      c.stake.sb,
      ovPct(c.override),
      ovCap(c.override)
    );
    const twin = effectiveRake({
      bb: c.stake.bb,
      sb: c.stake.sb,
      pot: c.pot,
      playersDealt: c.dealt,
      sawFlop: c.sawFlop,
      overridePercent: c.override?.rakePercent,
      overrideCapBB: c.override?.rakeCapBB,
    });
    const label = `${c.stake.sb}/${c.stake.bb} (${c.stake.note}) pot ${c.pot} dealt ${c.dealt} flop ${c.sawFlop} override ${JSON.stringify(c.override ?? null)}`;
    expect(engine, `engine vs SQL mirror: ${label}`).toBe(sql.rake);
    expect(twin.rake, `rakeSpec.effectiveRake vs SQL mirror: ${label}`).toBe(sql.rake);
    expect(twin.cap, `cap: ${label}`).toBe(sql.cap);
    expect(twin.percent, `percent: ${label}`).toBe(sql.percent);
    // Sanity that the case exercised something: a flop hand never exceeds
    // the cap, a no-flop hand is always 0.
    if (!c.sawFlop) expect(engine).toBe(0);
    expect(engine).toBeLessThanOrEqual(sql.cap + 1e-9);
  });

  it('the known answers the migration asserts hold on this side too', () => {
    expect(engineRake(1, 2, 100, 2, true)).toBe(2.5); // HU 5%, half cap
    expect(engineRake(1, 2, 100, 3, true)).toBe(3.35); // 3-dealt, 67% cap
    expect(engineRake(1, 2, 100, 6, false)).toBe(0); // no flop, no drop
    expect(engineRake(1.5, 3, 100, 6, true)).toBe(5); // tier-priced 3.00
    expect(engineRake(1, 2, 100, 6, true, { rakePercent: 20, rakeCapBB: 50 })).toBe(5);
  });
});

describe('LAW: one rake spec - the BBJ drop == fn_effective_bbj_drop', () => {
  const VARIANTS = ['nlh', 'plo4', 'plo5', 'plo6', 'short_deck', 'pineapple'];
  const bbjCases = CASES.filter((c) => !c.override).map((c, k) => ({
    ...c,
    variant: VARIANTS[k % VARIANTS.length],
  }));

  it.each(bbjCases.map((c) => [c.i, c] as const))('drop case %i', (_i, c) => {
    const engine = calculateBBJFee(c.stake.sb, c.stake.bb, c.sawFlop, c.dealt, c.variant);
    const sql = sqlEffectiveBbjDrop(
      c.stake.bb,
      c.dealt,
      c.sawFlop,
      c.variant,
      c.stake.sb,
      null,
      null
    );
    const twin = effectiveBbjDrop({
      bb: c.stake.bb,
      sb: c.stake.sb,
      playersDealt: c.dealt,
      sawFlop: c.sawFlop,
      variant: c.variant,
    });
    const label = `${c.stake.sb}/${c.stake.bb} ${c.variant} dealt ${c.dealt} flop ${c.sawFlop}`;
    expect(engine, `calculateBBJFee vs SQL mirror: ${label}`).toBe(sql);
    expect(twin, `effectiveBbjDrop vs SQL mirror: ${label}`).toBe(sql);
  });

  it('the pot ceiling yields the drop before the rake, identically on both sides', () => {
    // A tiny pot at 1/2 with 4 dealt: the 0.50 drop wants more than the pot holds.
    for (const pot of [0.02, 0.2, 0.37, 0.5, 0.52, 0.6, 1.5]) {
      const rake = engineRake(1, 2, pot, 4, true);
      const sql = sqlEffectiveBbjDrop(2, 4, true, 'nlh', 1, pot, rake);
      const twin = effectiveBbjDrop({ bb: 2, sb: 1, playersDealt: 4, sawFlop: true, pot, rake });
      expect(twin, `pot ${pot}`).toBe(sql);
      expect(rake + twin, `rake + drop must fit the pot ${pot}`).toBeLessThanOrEqual(pot + 1e-9);
    }
  });
});

describe('LAW: one rake spec - the checksum and the canonical rule', () => {
  it('rakeSpecChecksum() is what production returned and what the migration pins', () => {
    expect(rakeSpecChecksum()).toBe(PRODUCTION_CHECKSUM_2026_09_02);
    const migration = readFileSync(MIGRATION, 'utf8');
    const m = migration.match(/c_expected\s+constant\s+text\s*:=\s*'([0-9a-f]{32})'/);
    expect(m, 'the migration must pin c_expected').not.toBeNull();
    expect(m![1]).toBe(rakeSpecChecksum());
  });

  it('serialises the keys the SQL serialises, in the same order, in the same formats', () => {
    const text = rakeSpecCanonical();
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual(['caps', 'rules', 'schedule', 'tiers']);
    expect(Object.keys(parsed.caps[0])).toEqual(['bb', 'dealt', 'cap']);
    expect(Object.keys(parsed.rules)).toEqual([
      'bbj_ineligible_variants',
      'bbj_min_players_dealt',
      'bbj_min_pot_bb',
      'heads_up_cap_factor',
      'heads_up_percent',
      'max_rake_cap_bb',
      'max_rake_percent',
      'no_flop_no_drop',
      'short_handed_cap_factor',
      'short_handed_max_players',
      'unscheduled_cap_bb',
    ]);
    expect(Object.keys(parsed.schedule[0])).toEqual([
      'sb',
      'bb',
      'rake_percent',
      'rake_cap',
      'bbj_fee_bb',
    ]);
    expect(Object.keys(parsed.tiers[0])).toEqual([
      'label',
      'min_bb',
      'max_bb',
      'rake_percent',
      'rake_cap',
      'bbj_fee_bb',
    ]);
    // Compact: no whitespace anywhere outside strings (there are none inside).
    expect(text).not.toMatch(/\s/);
    // Money/percent/factor numbers are two-decimal STRINGS; counts are bare integers.
    for (const c of parsed.caps) {
      expect(c.bb).toMatch(/^\d+\.\d{2}$/);
      expect(c.cap).toMatch(/^\d+\.\d{2}$/);
      expect(Number.isInteger(c.dealt)).toBe(true);
    }
    expect(parsed.rules.heads_up_percent).toBe('5.00');
    expect(parsed.rules.unscheduled_cap_bb).toBe('15.00');
    expect(Number.isInteger(parsed.rules.bbj_min_players_dealt)).toBe(true);
    expect(parsed.rules.no_flop_no_drop).toBe(true);
    expect(parsed.tiers.at(-1).max_bb).toBeNull();
    // Orderings: caps by (bb, dealt), schedule by (bb, sb), tiers by min_bb,
    // ineligible variants in byte order.
    const capKeys = parsed.caps.map((c: { bb: string; dealt: number }) => [Number(c.bb), c.dealt]);
    expect(capKeys).toEqual([...capKeys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    const schedKeys = parsed.schedule.map((s: { bb: string; sb: string }) => [
      Number(s.bb),
      Number(s.sb),
    ]);
    expect(schedKeys).toEqual([...schedKeys].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    const tierKeys = parsed.tiers.map((t: { min_bb: string }) => Number(t.min_bb));
    expect(tierKeys).toEqual([...tierKeys].sort((a, b) => a - b));
    expect(parsed.rules.bbj_ineligible_variants).toEqual(
      [...parsed.rules.bbj_ineligible_variants].sort()
    );
    // 19 scheduled stakes + the tier-priced 3.00 = 20 stakes x 3 rungs.
    expect(parsed.caps).toHaveLength(60);
    expect(parsed.schedule).toHaveLength(RAKE_SCHEDULE.length);
  });

  it('the SQL builds the same key sequences (pinned from the migration text)', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    expect(migration).toContain(`'{"bb":"%s","dealt":%s,"cap":"%s"}'`);
    expect(migration).toContain(
      `'{"sb":"%s","bb":"%s","rake_percent":"%s","rake_cap":"%s","bbj_fee_bb":"%s"}'`
    );
    expect(migration).toContain(
      `'{"label":%s,"min_bb":"%s","max_bb":%s,"rake_percent":"%s","rake_cap":"%s","bbj_fee_bb":"%s"}'`
    );
    expect(migration).toContain(
      `'{"bbj_ineligible_variants":[%s],"bbj_min_players_dealt":%s,"bbj_min_pot_bb":%s,'`
    );
    expect(migration).toContain(
      `'"heads_up_cap_factor":"%s","heads_up_percent":"%s","max_rake_cap_bb":"%s",'`
    );
    expect(migration).toContain(
      `'"max_rake_percent":"%s","no_flop_no_drop":%s,"short_handed_cap_factor":"%s",'`
    );
    expect(migration).toContain(`'"short_handed_max_players":%s,"unscheduled_cap_bb":"%s"}'`);
    expect(migration).toContain(`'{"caps":['`);
    expect(migration).toContain(`'],"rules":'`);
    expect(migration).toContain(`',"schedule":['`);
    expect(migration).toContain(`'],"tiers":['`);
  });
});
