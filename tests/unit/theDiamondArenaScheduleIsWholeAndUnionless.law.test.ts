/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND ARENA'S TOURNAMENT SCHEDULE IS WHOLE, UNIONLESS, AND NEVER
 *  SCHEDULES AN EVENT THE DOOR REFUSES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The arena's starter board ships as data in
 * 20261006090619_the_diamond_arena_has_a_tournament_schedule. Data in a
 * migration has no type checker and no reviewer who will re-derive its
 * arithmetic, so these pins stand in for both. Each one corresponds to a thing
 * the live database or the live spawner will do to this board, measured on
 * production 2026-10-06:
 *
 *  - A GUARANTEE IS REFUSED. trg_tournaments_guarantee_affordable raises
 *    'diamond_guarantee_has_no_chip_bank' for any club whose asset is
 *    'diamonds', so a row promising one spawns a refusal rather than an event.
 *
 *  - A SATELLITE IS REFUSED. fn_award_satellite_seat raises
 *    'diamond_satellite_is_never_settled_on_chip_rails', so a Diamond
 *    satellite could sell a seat it can never deliver.
 *
 *  - A UNION TAKES THE MONEY DOORS OFFLINE. fn_poker_diamond_tournament only
 *    recognises a Diamond event while both the club's and the tournament's
 *    union_id are NULL, and fn_poker_guard_arena_structure refuses a Diamond
 *    game that carries one.
 *
 *  - THE PRICE IS SNAPPED, NOT STORED. ScheduledTournamentService passes
 *    config.buyIn through buyInFor -> snapToWholeBuyIn, so a figure that is
 *    not already a BUY_IN_LADDER rung is silently repriced. And because the
 *    fee is 10% floored to the cent while a Diamond is indivisible
 *    (DIAMOND_UNIT_CENTS = 100), only a rung that is a multiple of ten splits
 *    into two whole Diamonds.
 *
 *  - HORSES ARE PLAYERS (CLAUDE.md 10.5). The spawner falls back to
 *    min_players when horsesToRegister is absent or unparseable, which would
 *    pre-seat a field of horses into every event. The value must be present
 *    and 0 on every row.
 *
 * Anchored on the migration text and on BUY_IN_LADDER itself, never on prose.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { BUY_IN_LADDER, snapToWholeBuyIn, splitBuyIn } from '../../server/src/config/buyIn';

const MIGRATIONS = join(process.cwd(), 'supabase/migrations');
const SUFFIX = 'the_diamond_arena_has_a_tournament_schedule';
const ARENA_CLUB_ID = '002c2d27-9584-4e52-835a-bb2be148fc81';

/**
 * The INSERT statement alone. The header explains which keys the Diamond door
 * refuses and the post-image block guards against them by name, so a data
 * assertion that scanned the whole file would match its own documentation.
 */
function authoredRows(sql: string): string {
  const start = sql.indexOf('INSERT INTO public.tournament_schedules');
  expect(start, 'the migration must insert the board').toBeGreaterThan(-1);
  const end = sql.indexOf('-- \u2500\u2500 POST-IMAGE', start);
  expect(end, 'the migration must assert its post-image').toBeGreaterThan(start);
  return sql.slice(start, end);
}

function migration(): string {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${SUFFIX}.sql`));
  expect(file, `${SUFFIX} must exist in supabase/migrations`).toBeTruthy();
  return readFileSync(join(MIGRATIONS, file as string), 'utf8');
}

/**
 * The authored board, kept here as the thing the migration is checked AGAINST
 * rather than parsed out of it: a pin that reads its expectations from the
 * file it is pinning proves nothing.
 */
const BOARD = [
  { name: 'Diamond Freeroll', type: 'mtt', buyIn: 0, bounty: 0, stack: 5000, times: 4 },
  { name: 'Diamond Daily Turbo 300', type: 'mtt', buyIn: 300, bounty: 0, stack: 12000, times: 1 },
  {
    name: 'Diamond Daily Deep Stack 500',
    type: 'mtt',
    buyIn: 500,
    bounty: 0,
    stack: 30000,
    times: 1,
  },
  {
    name: 'Diamond Bounty Hunt 1000',
    type: 'bounty',
    buyIn: 1000,
    bounty: 225,
    stack: 18000,
    times: 1,
  },
  {
    name: 'Diamond Progressive Bounty 2000',
    type: 'progressive_bounty',
    buyIn: 2000,
    bounty: 900,
    stack: 22000,
    times: 1,
  },
] as const;

describe('the Diamond Arena starter schedule', () => {
  const sql = migration();

  it('writes its rows to the platform Diamond arena and nowhere else', () => {
    const clubRefs = sql.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g);
    expect(clubRefs, 'the migration must name a club').toBeTruthy();
    for (const ref of new Set(clubRefs as string[])) {
      expect(ref, 'no uuid other than the Diamond arena may appear').toBe(`'${ARENA_CLUB_ID}'`);
    }
  });

  it('names every event the board is meant to carry, and only those', () => {
    for (const row of BOARD) {
      expect(sql, `${row.name} must be scheduled`).toContain(`'${row.name}'`);
    }
    const inserts = authoredRows(sql).match(/'name',\s*'Diamond[^']*'/g) ?? [];
    expect(inserts).toHaveLength(BOARD.length);
  });

  it('sets union_id NULL on every row and never names a union or an agent', () => {
    const valueRows = authoredRows(sql).match(/^\s*\(NULL, '002c2d27/gm) ?? [];
    expect(valueRows, 'every VALUES row opens with a NULL union_id').toHaveLength(BOARD.length);
    const rows = authoredRows(sql);
    expect(rows).not.toMatch(/union_id\s*,?\s*'[0-9a-f]{8}-/);
    expect(rows.toLowerCase()).not.toMatch(/\bagent_id\b|\bparent_agent_id\b|\bcommission\b/);
  });

  describe('every price is a ladder rung that splits into whole Diamonds', () => {
    for (const row of BOARD) {
      if (row.buyIn === 0) continue;

      it(`${row.name}: ${row.buyIn} is a rung the spawner will not reprice`, () => {
        expect(BUY_IN_LADDER as readonly number[]).toContain(row.buyIn);
        // The spawner snaps before it splits. A rung snaps to itself, so the
        // player pays exactly what this board advertises.
        expect(snapToWholeBuyIn(row.buyIn)).toBe(row.buyIn);
      });

      it(`${row.name}: its 10% split is two whole Diamonds`, () => {
        const split = splitBuyIn(row.buyIn);
        expect(split.total).toBe(row.buyIn);
        expect(Number.isInteger(split.fee)).toBe(true);
        expect(Number.isInteger(split.prize)).toBe(true);
        expect(split.prize + split.fee).toBe(split.total);
        // The constraint that restricts this arena to the ten-Diamond rungs.
        expect(row.buyIn % 10).toBe(0);
      });

      it(`${row.name}: its bounty is Midway's own share of the prize side, whole`, () => {
        const { prize } = splitBuyIn(row.buyIn);
        if (row.type === 'bounty') {
          // Midway: "25% Of Each Entry Contribution Funds A Fixed Knockout
          // Bounty" - 25% of the prize side (chip 11 -> prize 10 -> 2.5).
          expect(row.bounty).toBe(prize * 0.25);
        } else if (row.type === 'progressive_bounty') {
          // Midway's PKO: 50% of the prize side (chip 15 -> prize 13.5 -> 6.75).
          expect(row.bounty).toBe(prize * 0.5);
        } else {
          expect(row.bounty).toBe(0);
        }
        expect(Number.isInteger(row.bounty)).toBe(true);
      });

      it(`${row.name}: the entry split reconciles to the advertised total`, () => {
        const { prize, fee } = splitBuyIn(row.buyIn);
        // fn_tournament_entry_split: charge = prize + bounty + rake, with the
        // bounty taken OUT of the prize side rather than added on top.
        expect(prize - row.bounty + row.bounty + fee).toBe(row.buyIn);
        expect(Number.isInteger(prize - row.bounty)).toBe(true);
      });
    }

    it('every starting stack is a whole number of tournament chips', () => {
      for (const row of BOARD) expect(Number.isInteger(row.stack)).toBe(true);
    });

    it('authors no fractional money value anywhere in the file', () => {
      // Any x.y literal in a config value would be a chip-shaped price that
      // this arena cannot hold. Comments quoting the chip ladder are excluded.
      const body = sql
        .split('\n')
        .filter((l) => !l.trimStart().startsWith('--'))
        .join('\n');
      expect(body).not.toMatch(
        /'(buyIn|bountyAmount|guaranteedPrize|rebuyCost|addonCost)',\s*\d+\.\d/
      );
    });
  });

  it('promises no guarantee, because the Diamond door refuses one', () => {
    const promises = authoredRows(sql).match(/'guaranteedPrize',\s*(\d+)/g) ?? [];
    expect(promises).toHaveLength(BOARD.length);
    for (const p of promises) expect(p).toMatch(/'guaranteedPrize',\s*0$/);
    expect(sql).toContain('diamond_guarantee_has_no_chip_bank');
  });

  it('schedules no satellite and no spin, because both are refused', () => {
    const body = authoredRows(sql)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n');
    expect(body).not.toMatch(/'type',\s*'satellite'/);
    expect(body).not.toMatch(/'type',\s*'spin'/);
    expect(body).not.toMatch(/satelliteSeats|satelliteTargetName|satelliteTargetId/);
    expect(sql).toContain('diamond_satellite_is_never_settled_on_chip_rails');
  });

  it('sets horsesToRegister to 0 explicitly on every row', () => {
    const horses = authoredRows(sql).match(/'horsesToRegister',\s*(\d+)/g) ?? [];
    expect(horses, 'omitting the key makes the spawner pre-seat min_players').toHaveLength(
      BOARD.length
    );
    for (const h of horses) expect(h).toMatch(/'horsesToRegister',\s*0$/);
  });

  it('gives every row a clock the poller can spawn from', () => {
    const days = authoredRows(sql).match(/ARRAY\[0,1,2,3,4,5,6\]::integer\[\]/g) ?? [];
    expect(days).toHaveLength(BOARD.length);
    const times = authoredRows(sql).match(/ARRAY\['\d\d:\d\d'(?:,'\d\d:\d\d')*\]::text\[\]/g) ?? [];
    expect(times).toHaveLength(BOARD.length);
    const slots = BOARD.reduce((n, r) => n + r.times, 0);
    expect((authoredRows(sql).match(/'\d\d:\d\d'/g) ?? []).length).toBe(slots);
  });

  it('keeps player-facing copy free of the em dash', () => {
    const copy = authoredRows(sql).match(/'shortDescription',\s*'[^']*'/g) ?? [];
    expect(copy).toHaveLength(BOARD.length);
    for (const c of copy) expect(c).not.toContain('\u2014');
    for (const row of BOARD) expect(row.name).not.toContain('\u2014');
  });

  it('asserts its own pre- and post-image, and leaves the arena switches alone', () => {
    expect(sql).toMatch(/pre-image:/);
    expect(sql).toMatch(/post-image:/);
    expect(sql).toContain('the arena switches moved');
    // It reads ca_arena_settings to prove the switches are untouched; it must
    // never write to it, nor to the clubs row.
    expect(sql).not.toMatch(/(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+public\.ca_arena_settings/i);
    expect(sql).not.toMatch(/(UPDATE|DELETE\s+FROM)\s+public\.clubs/i);
    const writes = sql.match(/INSERT\s+INTO\s+public\.\w+/gi) ?? [];
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/tournament_schedules/);
  });
});
