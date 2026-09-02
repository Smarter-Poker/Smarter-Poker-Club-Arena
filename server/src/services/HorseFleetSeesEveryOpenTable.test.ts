/**
 * The seeder must be able to SEE every open table, not the first thousand.
 *
 * seedAllTables() read its table list with a bare `.select()` — no ordering,
 * no paging. PostgREST caps every response at db-max-rows (1,000 here) and
 * does NOT error when it truncates, so the seeder simply received a short
 * list and believed it was the whole floor.
 *
 * This is the same silent truncation that was found and fixed for the SEAT
 * map on 2026-08-20, thirty lines further down the same method. The seat fix
 * hid the consequence instead of removing it, because the two failures point
 * in opposite directions:
 *
 *   - a truncated SEAT map makes an occupied seat read as empty, and fails
 *     LOUDLY — ~150,000 duplicate-key buy-ins a day;
 *   - a truncated TABLE list makes a table not exist at all, and fails
 *     SILENTLY — nothing is attempted, so nothing is logged, so the floor
 *     just never fills and there is no error anywhere that says why.
 *
 * Measured on 2026-09-02: 1,134 live non-tournament tables against a 1,000
 * cap. Unordered PostgREST reads come back in physical order, which tracks
 * insertion, so the 134 that fell off were the NEWEST — the worst possible
 * ones to lose, since a table nobody has sat at yet is exactly the one that
 * needs seeding. All 45 Midway Union micro tables created that morning ranked
 * 1090-1134 and not one was ever offered a horse, while Deep Stack Society
 * (older, inside the first 1,000) seeded normally all day.
 *
 * Source assertions rather than a driven fake: what is being pinned is the
 * SHAPE of the query, and a fake client would have to reproduce PostgREST's
 * silent cap to catch the regression at all — which is the one behaviour a
 * hand-written fake is least likely to model, and precisely how this survived
 * the seat fix.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sliceBlockAfter } from '../testHelpers/sourceWindow.js';

const SRC = readFileSync(join(__dirname, 'HorseFleetManager.ts'), 'utf8');

/** The body of seedAllTables, where the open-table read lives. */
function seedAllTablesBody(): string {
  const start = SRC.indexOf('private async seedAllTables(');
  expect(start, 'seedAllTables() not found - has it been renamed?').toBeGreaterThan(-1);
  const next = SRC.indexOf('\n  private async ', start + 1);
  return SRC.slice(start, next === -1 ? SRC.length : next);
}

describe('the horse seeder sees every open table', () => {
  it('reads the open-table list through fetchAllRows, not a bare select', () => {
    const body = seedAllTablesBody();
    expect(body).toContain('fetchAllRows<');
    expect(body).toContain("label: 'HorseFleet.openTables'");
  });

  it('pages that read by keyset on id, so the 1,000-row cap cannot apply', () => {
    const body = seedAllTablesBody();
    // Exactly the open-table read: from the fetchAllRows call to its label.
    const from = body.indexOf('const tablePage = await fetchAllRows');
    const to = body.indexOf("label: 'HorseFleet.openTables'");
    expect(from, 'open-table read not found').toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const read = body.slice(from, to);
    // Ordered so paging is deterministic, limited to the page size the helper
    // asks for, and advanced by a cursor rather than an offset.
    expect(read).toMatch(/\.order\('id',\s*\{\s*ascending:\s*true\s*\}\)/);
    expect(read).toContain('.limit(want)');
    expect(read).toMatch(/q\.gt\('id',\s*cursor\)/);
    // OFFSET paging re-reads under a fresh snapshot per page, so a table that
    // opens or closes mid-read shifts every later row and one gets skipped.
    expect(read).not.toContain('.range(');
  });

  it('fails closed when the table list comes back incomplete', () => {
    const body = seedAllTablesBody();
    expect(body).toMatch(/if\s*\(!tablePage\.complete\)/);
    // A partial list must abandon the cycle, never seed from what arrived.
    // Bounded by the if-block, never by a byte count: a fixed window went red
    // for the whole estate on 2026-08-28 when comments moved the code past it.
    expect(sliceBlockAfter(body, 'if (!tablePage.complete)')).toContain('return;');
  });

  it('never reintroduces an unpaged read of the open-table list', () => {
    const body = seedAllTablesBody();
    // The exact shape that was truncated: a tables select filtered to open
    // non-tournament rows with no limit on it.
    const bare =
      /\.from\('tables'\)\s*\.select\([\s\S]{0,400}?\)\s*\.is\('tournament_id',\s*null\)\s*\.in\('status',\s*\[[^\]]*\]\)\s*;/;
    expect(bare.test(body), 'seedAllTables reads tables without paging again').toBe(false);
  });
});
