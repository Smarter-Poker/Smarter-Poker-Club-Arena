/**
 * A seeding cycle must finish inside the tick that started it.
 *
 * `seedAllTables` runs on a 30-second interval, and a tick that arrives while
 * the previous cycle is still going is DROPPED - counted in `overrunTicks` and
 * otherwise thrown away. So a cycle that overruns does not simply run late: it
 * deletes the refills that should have happened while it ran, and the floor
 * goes unseeded for as long as it takes.
 *
 * Measured on production across three hours on 2026-09-11, every cycle
 * overran, without exception:
 *
 *   31, 34, 36, 36, 49, 49, 50, 60, 63, 63, 63, 63, 63, 65, 67, 75, 76, 76,
 *   84, 84, 109, 109 seconds
 *
 * each one logging `N 30s tick(s) were dropped while it ran - the floor was
 * not refilled for that long`.
 *
 * Timestamping a single 109-second cycle showed where it went: five
 * `atomic_table_buyin` calls that timed out, 5.8 to 11.7 seconds apart, one
 * after another. The loop is sequential by construction - each seat updates
 * the exposure and per-host body counts that the NEXT decision reads, which
 * the code comments defend explicitly - so a single call in the tail stalls
 * every table behind it.
 *
 * The same buy-in, timed uncontended in a self-aborting probe against
 * production, is 132 ms. Its recorded mean over 9,767 calls is 1,336 ms with a
 * 27.3-second maximum: the middle is fast and the tail is very long.
 *
 * Two bounds, therefore, and the arithmetic between them is the point:
 *
 *   - the cycle stops STARTING seats at 18 s;
 *   - a single seat purchase is abandoned at 5 s;
 *   - the Stable Hand state write measured 3.5 s;
 *
 * 18 + 5 + 3.5 = 26.5 < 30, so the next tick always fires.
 *
 * Source assertions rather than a driven fake, for the same reason
 * HorseFleetSeesEveryOpenTable pins a query shape: what is being protected is
 * an ARITHMETIC RELATIONSHIP between three constants in two files, and a fake
 * that could exercise it would have to reproduce the interval, the drop rule
 * and PostgREST's deadline to catch a regression at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fleet = readFileSync(resolve(here, 'HorseFleetManager.ts'), 'utf8');
const client = readFileSync(resolve(here, 'supabase/client.ts'), 'utf8');

/** Comment-stripped, so prose about a number can never satisfy an assertion. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const numberFor = (src: string, name: string): number => {
  const m = new RegExp(`${name}\\s*\\?\\?\\s*([0-9_]+)`).exec(code(src));
  expect(m, `${name} has no numeric default`).not.toBeNull();
  return Number(m![1].replace(/_/g, ''));
};

describe('a seeding cycle finishes inside its tick', () => {
  it('the seeding interval is still 30 seconds and still drops an overrun tick', () => {
    // Both halves matter: if the interval grew, the budget below is wrong; if
    // the drop were removed, an overrun would merely queue rather than delete.
    expect(code(fleet)).toMatch(/setInterval\([\s\S]{0,800}?\}, 30000\)/);
    expect(code(fleet)).toMatch(/this\.overrunTicks\+\+/);
  });

  it('the cycle stops starting seats at its time budget', () => {
    const c = code(fleet);
    expect(c).toMatch(/Date\.now\(\)\s*-\s*cycleStartedAt\s*>=\s*SEED_CYCLE_SEATING_BUDGET_MS/);
    // Named, so a withheld table is reportable rather than invisible.
    expect(c).toContain("'cycle_time_budget'");
    expect(c).toMatch(/firstTableWithheld = 'cycle_time_budget'/);
    // Counted in the same beat field as the other withholdings, which is what
    // publishFleetState sends out as withheld_tables.
    const guard = /SEED_CYCLE_SEATING_BUDGET_MS\)\s*\{\s*beat\.withheldTables\+\+/;
    expect(c).toMatch(guard);
  });

  it('the seat purchase uses the seeding deadline, not the dealing one', () => {
    const c = code(fleet);
    // Every atomic_table_buyin the fleet makes, without exception.
    expect(c).toMatch(/seedingSupabase\.rpc\('atomic_table_buyin'/);
    expect(c).not.toMatch(/\bsupabase\.rpc\('atomic_table_buyin'/);
    expect(c).toMatch(/import \{[^}]*seedingSupabase[^}]*\} from '\.\/supabase\.js'/);
  });

  it('a seeding call is abandoned well before a dealing call would be', () => {
    const seeding = numberFor(client, 'SEEDING_SUPABASE_TIMEOUT_MS');
    const dealing = numberFor(client, 'SUPABASE_TIMEOUT_MS');
    expect(seeding).toBe(5_000);
    expect(dealing).toBe(15_000);
    expect(seeding).toBeLessThan(dealing);
    // 38x the 132 ms an uncontended buy-in actually costs.
    expect(seeding / 132).toBeGreaterThan(20);
  });

  it('budget plus one abandoned call plus the state write fits inside the tick', () => {
    const budget = numberFor(fleet, 'HORSE_SEED_CYCLE_SEATING_BUDGET_MS');
    const seeding = numberFor(client, 'SEEDING_SUPABASE_TIMEOUT_MS');
    const STABLE_HAND_STATE_WRITE_MS = 3_500; // measured 2026-09-11
    const TICK_MS = 30_000;
    expect(budget).toBe(18_000);
    expect(budget + seeding + STABLE_HAND_STATE_WRITE_MS).toBeLessThan(TICK_MS);
  });

  it('both bounds are operator-overridable without a release', () => {
    expect(code(fleet)).toContain('process.env.HORSE_SEED_CYCLE_SEATING_BUDGET_MS');
    expect(code(client)).toContain('process.env.SEEDING_SUPABASE_TIMEOUT_MS');
  });
});
