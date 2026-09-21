/**
 * A FROZEN TOURNAMENT DOES NOT RESUME ON A STALE ANTE (2026-09-21)
 *
 * 45 RUNNING tournaments are not dealing: 39 held on a break that expired
 * 2026-09-18 22:00:00+00, and 6 owning no row in engine_tournament_leases.
 * 171 live public.tables rows across 25 of them store `ante = big_blind`
 * EXACTLY, against structures that author 0.120-0.1333 x bigBlind.
 *
 * WHY THIS IS A MONEY DEFECT AND NOT A COSMETIC ONE. `ante_enabled` is false
 * on all 171 rows, which for a CASH table would end the matter. A tournament
 * table ignores it - ServerTableEngine.ts:174 and ServerTableEngineDealing.ts
 * :2666 both read `info.tournament_id ? true : (ante_enabled ?? true)`,
 * deliberately, because ante_enabled is false on every table row in the
 * estate and gating on it meant no tournament ante was ever posted.
 * `big_blind_ante_enabled` is false on all 171 too, so HandController takes
 * the per-player arm at :536 - `Math.min(this.config.ante, player.stack)` -
 * which has NO ceiling. Every seated player posts a full big blind every
 * hand, and a short stack is blinded off in one.
 *
 * WHY IT HAS NOT FIRED YET. The stale ante persists BECAUSE the tournament is
 * frozen: fn_publish_tournament_blind_level is the only writer of these
 * columns, it returns ok:false/'paused' while on_break is true, and it cannot
 * republish the level a tournament is already on (p_next_level <=
 * p_previous_level raises 22023). Both freezes have merged repairs awaiting a
 * deploy that has been failing for two days - #4993 for the expired break,
 * #5010 for the leaseless manager. The instant that deploy lands, these
 * events are adopted and resume, and a manager adopting mid-level does not
 * publish a level: it restarts the level clock and the tables deal from
 * whatever public.tables already holds.
 *
 * So the correction has to be durable in the database BEFORE the resumption,
 * which is what 20260921130516 does and what this file pins. StaleBreakAdoption
 * Heal.test.ts already proves the break itself releases on adoption; this
 * proves what the ante is when it does.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anteOrbitCostBB } from '../engine/AnteMath.js';

const repo = join(process.cwd(), '..');
const migrations = join(repo, 'supabase', 'migrations');

const migrationPath = (suffix: string): string => {
  const matches = readdirSync(migrations)
    .filter((name) => name.endsWith(`_${suffix}`) || name.endsWith(`_${suffix}.pending`))
    .map((name) => join(migrations, name));
  expect(matches, `expected exactly one staged-or-promoted ${suffix}`).toHaveLength(1);
  return matches[0] ?? '';
};

const SQL = readFileSync(
  migrationPath('a_frozen_tournament_does_not_resume_on_a_stale_ante.sql'),
  'utf8'
);

/**
 * The production pre-image, measured 2026-09-21 ~12:55 UTC against
 * kuklfnapbkmacvwxktbh. `anchorAnte`/`anchorBigBlind` are the last non-break
 * authored level of each tournament's own blind_structure - the same anchor
 * row fn_resolve_tournament_blinds grows its overflow blinds from.
 */
const MEASURED = [
  {
    id: '0751a1fc',
    name: 'Morning Free Buy (NLH)',
    rows: 2,
    bigBlind: 7950.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 7950.0,
    correctedAnte: 993,
    maxSeats: 9,
  },
  {
    id: '186e32a8',
    name: 'Saturday Night Big Stack Satellite',
    rows: 1,
    bigBlind: 2500.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 2500.0,
    correctedAnte: 333,
    maxSeats: 2,
  },
  {
    id: '1b9e03ba',
    name: 'Lunch Rush (NLH Deep)',
    rows: 3,
    bigBlind: 10500.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 10500.0,
    correctedAnte: 1312,
    maxSeats: 9,
  },
  {
    id: '1d29ce9e',
    name: 'Pre-Dawn Mystery Bounty (PLO5)',
    rows: 2,
    bigBlind: 3150.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 3150.0,
    correctedAnte: 420,
    maxSeats: 5,
  },
  {
    id: '314254d9',
    name: 'Sunday Deep Stack Satellite $10',
    rows: 1,
    bigBlind: 8000.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 8000.0,
    correctedAnte: 1000,
    maxSeats: 2,
  },
  {
    id: '3682bec2',
    name: 'Sunday Deep Stack Satellite $5',
    rows: 2,
    bigBlind: 5199.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 5199.0,
    correctedAnte: 693,
    maxSeats: 7,
  },
  {
    id: '4372676a',
    name: 'Prime Time Free Buy (NLH)',
    rows: 21,
    bigBlind: 41650.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 41650.0,
    correctedAnte: 5206,
    maxSeats: 9,
  },
  {
    id: '615783bf',
    name: 'Afternoon Free Buy (NLH)',
    rows: 9,
    bigBlind: 48750.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 48750.0,
    correctedAnte: 6093,
    maxSeats: 5,
  },
  {
    id: '65a4a06e',
    name: 'Prime Time Free Buy (NLH)',
    rows: 33,
    bigBlind: 49000.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 49000.0,
    correctedAnte: 6125,
    maxSeats: 8,
  },
  {
    id: '6a6d0385',
    name: 'Five-Card Bounty',
    rows: 5,
    bigBlind: 34200.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 34200.0,
    correctedAnte: 4275,
    maxSeats: 5,
  },
  {
    id: '6ba7e042',
    name: 'Sunday Deep Stack Satellite $5',
    rows: 1,
    bigBlind: 2799.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 2799.0,
    correctedAnte: 373,
    maxSeats: 7,
  },
  {
    id: '7998dd28',
    name: 'Omaha Thursday Opener',
    rows: 2,
    bigBlind: 31500.0,
    anchorAnte: 50000,
    anchorBigBlind: 400000,
    storedAnte: 31500.0,
    correctedAnte: 3937,
    maxSeats: 7,
  },
  {
    id: '7e19ea1d',
    name: 'Sunday Deep Stack Satellite $10',
    rows: 1,
    bigBlind: 8000.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 8000.0,
    correctedAnte: 1000,
    maxSeats: 2,
  },
  {
    id: '80042176',
    name: 'Saturday Night Big Stack Satellite',
    rows: 1,
    bigBlind: 1499.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 1499.0,
    correctedAnte: 199,
    maxSeats: 3,
  },
  {
    id: '83997d70',
    name: 'Six-Card Feature',
    rows: 3,
    bigBlind: 30000.0,
    anchorAnte: 50000,
    anchorBigBlind: 400000,
    storedAnte: 30000.0,
    correctedAnte: 3750,
    maxSeats: 7,
  },
  {
    id: '8f29fb87',
    name: 'Six-Card Feature',
    rows: 4,
    bigBlind: 51000.0,
    anchorAnte: 50000,
    anchorBigBlind: 400000,
    storedAnte: 51000.0,
    correctedAnte: 6375,
    maxSeats: 7,
  },
  {
    id: '98d247a3',
    name: 'Coffee Break Freeroll (PLO4)',
    rows: 4,
    bigBlind: 9750.0,
    anchorAnte: 60000,
    anchorBigBlind: 500000,
    storedAnte: 9750.0,
    correctedAnte: 1170,
    maxSeats: 6,
  },
  {
    id: '99271c16',
    name: 'Afternoon Free Buy (NLH)',
    rows: 8,
    bigBlind: 44000.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 44000.0,
    correctedAnte: 5500,
    maxSeats: 1,
  },
  {
    id: '9b0ae419',
    name: 'Midnight Bounty (NLH)',
    rows: 2,
    bigBlind: 3450.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 3450.0,
    correctedAnte: 460,
    maxSeats: 8,
  },
  {
    id: '9e2e79be',
    name: 'Sunday Deep Stack Satellite $5',
    rows: 1,
    bigBlind: 5999.0,
    anchorAnte: 200000,
    anchorBigBlind: 1500000,
    storedAnte: 5999.0,
    correctedAnte: 799,
    maxSeats: 2,
  },
  {
    id: 'a54f6bf1',
    name: 'Five-Card Bounty',
    rows: 2,
    bigBlind: 24300.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 24300.0,
    correctedAnte: 3037,
    maxSeats: 9,
  },
  {
    id: 'a565d424',
    name: 'Morning Free Buy (NLH)',
    rows: 27,
    bigBlind: 88900.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 88900.0,
    correctedAnte: 11112,
    maxSeats: 9,
  },
  {
    id: 'cb6f3704',
    name: 'Midnight Free Buy (NLH)',
    rows: 27,
    bigBlind: 85400.0,
    anchorAnte: 10000,
    anchorBigBlind: 80000,
    storedAnte: 85400.0,
    correctedAnte: 10675,
    maxSeats: 9,
  },
  {
    id: 'df2597fb',
    name: 'Union Morning Classic (NLH)',
    rows: 5,
    bigBlind: 9500.0,
    anchorAnte: 500000,
    anchorBigBlind: 4000000,
    storedAnte: 9500.0,
    correctedAnte: 1187,
    maxSeats: 8,
  },
  {
    id: 'e30c7ef1',
    name: 'Omaha Thursday Opener',
    rows: 4,
    bigBlind: 51000.0,
    anchorAnte: 50000,
    anchorBigBlind: 400000,
    storedAnte: 51000.0,
    correctedAnte: 6375,
    maxSeats: 9,
  },
] as const;

/** The resolver's mtt_overflow ante ceiling, transcribed from its own body. */
const anteCeiling = (bigBlind: number, anchorAnte: number, anchorBigBlind: number): number =>
  (bigBlind * anchorAnte) / anchorBigBlind;

const correctedAnte = (bigBlind: number, anchorAnte: number, anchorBigBlind: number): number =>
  Math.max(1, Math.floor(anteCeiling(bigBlind, anchorAnte, anchorBigBlind)));

describe('the migration corrects the ante to its authored share', () => {
  it('reproduces every measured correction from the resolver rule alone', () => {
    expect(MEASURED).toHaveLength(25);
    expect(MEASURED.reduce((n, r) => n + r.rows, 0)).toBe(171);
    for (const row of MEASURED) {
      expect(
        correctedAnte(row.bigBlind, row.anchorAnte, row.anchorBigBlind),
        `${row.id} ${row.name}`
      ).toBe(row.correctedAnte);
    }
  });

  it('never raises an ante, and never drives one below a chip', () => {
    for (const row of MEASURED) {
      expect(row.correctedAnte, `${row.id}`).toBeLessThan(row.storedAnte);
      expect(row.correctedAnte, `${row.id}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every stored ante was exactly one big blind, 7.5x to 8.34x its authored share', () => {
    for (const row of MEASURED) {
      expect(row.storedAnte, `${row.id}`).toBe(row.bigBlind);
      const factor = row.storedAnte / row.correctedAnte;
      expect(factor, `${row.id}`).toBeGreaterThanOrEqual(7.5);
      expect(factor, `${row.id}`).toBeLessThanOrEqual(8.34);
    }
  });

  it('the authored share these structures ask for is 12.0% to 13.34% of the big blind', () => {
    for (const row of MEASURED) {
      const share = row.anchorAnte / row.anchorBigBlind;
      expect(share, `${row.id}`).toBeGreaterThanOrEqual(0.12);
      expect(share, `${row.id}`).toBeLessThanOrEqual(0.1334);
    }
  });
});

describe('what the correction is worth at the moment of resumption', () => {
  /**
   * The engine's own orbit arithmetic, not a restatement of it. These rows
   * are per-player antes (big_blind_ante_enabled false on all 171), so
   * anteOrbitCostBB is `ante x seats / bigBlind`: with ante = bigBlind that
   * is one big blind per seat per orbit.
   */
  it('a stale row costs one big blind per seat per orbit', () => {
    for (const row of MEASURED) {
      const stale = anteOrbitCostBB(row.storedAnte, row.maxSeats, row.bigBlind, false);
      expect(stale, `${row.id}`).toBeCloseTo(row.maxSeats, 6);
    }
  });

  it('the corrected row costs the share the structure authored, to the chip', () => {
    for (const row of MEASURED) {
      const authoredChips = anteCeiling(row.bigBlind, row.anchorAnte, row.anchorBigBlind);
      // floor() is the only thing between the corrected ante and the exact
      // authored share, so the gap is under one chip - never a proportion.
      expect(row.correctedAnte, `${row.id}`).toBeLessThanOrEqual(authoredChips);
      expect(row.correctedAnte, `${row.id}`).toBeGreaterThan(authoredChips - 1);

      const fixed = anteOrbitCostBB(row.correctedAnte, row.maxSeats, row.bigBlind, false);
      const authored = (authoredChips * row.maxSeats) / row.bigBlind;
      expect(fixed, `${row.id}`).toBeLessThanOrEqual(authored + 1e-9);
      expect(fixed, `${row.id}`).toBeGreaterThan(authored - row.maxSeats / row.bigBlind);
    }
  });

  it('the worst table drops from 9 big blinds an orbit to 1.125', () => {
    const worst = MEASURED.filter((r) => r.maxSeats === 9);
    expect(worst.length).toBeGreaterThan(0);
    for (const row of worst) {
      expect(anteOrbitCostBB(row.storedAnte, 9, row.bigBlind, false)).toBeCloseTo(9, 6);
      expect(anteOrbitCostBB(row.correctedAnte, 9, row.bigBlind, false)).toBeLessThan(1.126);
    }
  });

  /**
   * HandController.ts:536 posts Math.min(ante, player.stack) per player with
   * no ceiling. At ante = bigBlind, any stack under one big blind is taken
   * whole before a card is dealt.
   */
  it('a stale ante takes a sub-big-blind stack entire, the corrected one does not', () => {
    const row = MEASURED.find((r) => r.id === 'cb6f3704');
    expect(row).toBeDefined();
    const stack = row!.bigBlind - 1;
    expect(Math.min(row!.storedAnte, stack)).toBe(stack);
    expect(Math.min(row!.correctedAnte, stack)).toBe(row!.correctedAnte);
    expect(row!.correctedAnte).toBeLessThan(stack);
  });
});

describe('the rules the migration must keep', () => {
  it('only corrects levels past the end of the authored structure', () => {
    // fn_resolve_tournament_blinds returns a persisted level verbatim while
    // v_index < v_len. Tournament 7c6277e7 sits at level 15 of 30 with
    // ante 200 against big blind 1500 - an authored 13.3% - and the resolver
    // answers {"ante":200,"source":"persisted"} for it.
    expect(SQL).toContain(
      'COALESCE(t.current_level,0) >= jsonb_array_length(t.blind_structure::jsonb)'
    );
    // The anchor share must NOT be applied to that row.
    expect(correctedAnte(1500, 200_000, 1_500_000)).toBe(200);
    expect(correctedAnte(1500, 10_000, 80_000)).toBe(187);
  });

  it('only touches tournaments that provably cannot deal a hand', () => {
    expect(SQL).toContain('COALESCE(t.on_break,false) AND t.break_ends_at < now()');
    expect(SQL).toContain('STALE_ANTE_WOULD_TOUCH_A_DEALING_TOURNAMENT');
  });

  it('excludes a genuine big blind ante instead of flattening it', () => {
    expect(SQL).toContain('anchor_ante < anchor_bb');
    expect(SQL).toContain('COALESCE(t.big_blind_ante,false) = false');
  });

  it('is a ceiling: it asserts no ante was raised', () => {
    expect(SQL).toContain('STALE_ANTE_PLAN_WOULD_NOT_LOWER_AN_ANTE');
    expect(SQL).toContain('GREATEST(1, floor(tb.big_blind * c.anchor_ante / c.anchor_bb))');
  });

  it('leaves the small blind, the big blind and the stakes string alone', () => {
    expect(SQL).toContain('tb.small_blind IS DISTINCT FROM');
    expect(SQL).toContain('tb.big_blind IS DISTINCT FROM');
    expect(SQL).toContain('tb.stakes IS DISTINCT FROM');
    expect(SQL).toContain('STALE_ANTE_TABLE_POSTIMAGE_REFUSED');
    // The UPDATE sets exactly one column.
    expect(SQL).toContain('UPDATE public.tables tb\n       SET ante =');
  });

  it('pins both functions it reasons from, and alters neither', () => {
    expect(SQL).toContain('STALE_ANTE_RESOLVER_PREIMAGE_CHANGED');
    expect(SQL).toContain('STALE_ANTE_PUBLISHER_PREIMAGE_CHANGED');
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/\bALTER\s+FUNCTION\b/i);
    expect(SQL).not.toMatch(/\bDROP\s+FUNCTION\b/i);
  });

  it('is one transaction, declares its live proof, and adds no field-size cap', () => {
    expect(SQL).toMatch(/^BEGIN;$/m);
    expect(SQL).toMatch(/^COMMIT;$/m);
    expect(SQL).not.toMatch(/\bCONCURRENTLY\b/i);
    expect(SQL).not.toMatch(/\bVACUUM\b/i);
    expect(SQL).toContain('-- @live-proof:');
    expect(SQL).not.toMatch(/max_players/i);
  });

  it('corrects the durable tournament anchor in the same transaction', () => {
    expect(SQL).toContain("jsonb_set(t.blind_level_state, '{ante}'");
    expect(SQL).toContain('STALE_ANTE_STATE_POSTIMAGE_REFUSED');
    const begins = (SQL.match(/^BEGIN;$/gm) ?? []).length;
    expect(begins).toBe(1);
  });

  it('asserts the end state over the whole live estate, not just the rows it planned', () => {
    expect(SQL).toContain('STALE_ANTE_STILL_LIVE_AFTER_CORRECTION');
  });
});
