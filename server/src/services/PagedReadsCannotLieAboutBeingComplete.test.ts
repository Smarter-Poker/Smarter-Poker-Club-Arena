/**
 * NO CEILING ON PEOPLE, AND NO READ THAT LIES ABOUT BEING COMPLETE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-27: "there should never be a cap on the amount of players in
 * the club, union or anywhere else."
 *
 * To be precise about what was found: none of these were caps on PLAYERS -
 * nobody was ever stopped from joining, sitting or playing. They were page
 * sizes on background reads. But a read that silently returns part of the
 * room caps what the code can SEE, and every one of these then treated its
 * slice as the whole:
 *
 *   HorseSessionRotator.rotate   .limit(400), unordered. The room held 348
 *                                live seats when this was measured - 87% of
 *                                it. Past 400 Postgres returns an ARBITRARY
 *                                400: tables stop rotating, no error, no log.
 *   horseLoadMap (x2)            .limit(20000) on both halves. Its own
 *                                docstring says a truncated set understates
 *                                load and hands a horse a fifth table, and
 *                                that "Unknown is UNKNOWN" - but nothing
 *                                checked for a full page.
 *   entrant guard                .limit(20000) on "who is already in this
 *                                tournament". A missing id there is a horse
 *                                registered into the SAME tournament twice -
 *                                the bug that block exists to prevent.
 *
 * All four now PAGE. There is no number left to outgrow, which is the point:
 * raising a ceiling only moves the day it is hit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
/** Strip comments so prose describing the old ceilings cannot satisfy a pin. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('HorseSessionRotator sees the whole room', () => {
  const src = code(read('services/HorseSessionRotator.ts'));

  it('has no row ceiling at all', () => {
    expect(src).not.toMatch(/\.limit\(\s*\d+\s*\)/);
  });

  it('pages until a short page says the room is exhausted', () => {
    expect(src).toMatch(/\.range\(page \* PAGE/);
    expect(src).toMatch(/if \(chunk\.length < PAGE\) break;/);
  });

  it('orders the scan, so paging cannot serve a seat twice or skip one', () => {
    expect(src).toMatch(/\.order\('table_id'/);
    expect(src).toMatch(/\.order\('seat_number'/);
  });

  it('declines the pass on a failed page rather than rotating half a room', () => {
    /* THE PIN MOVED WITH THE MECHANISM (2026-09-09, CLAUDE.md 10.6).
     *
     * This asserted the exact one-line form `if (error || !chunk) return;`.
     * The branch is now a block, because a bare return was the whole defect
     * on 2026-09-09: two migrations added composite foreign keys from
     * `table_seats` to `tables`, PostgREST refused the unqualified embed
     * (PGRST201), every page failed, and the rotator declined every pass for
     * three and a half hours in complete silence. The room read is the only
     * read it has, so session ends, lone stands, tournament leaves, seat
     * changes and the human release rule all stopped at once and nothing
     * anywhere said so.
     *
     * THE CONTRACT THIS FILE EXISTS FOR IS UNCHANGED and is asserted more
     * strictly than before: a failed page still declines the pass rather than
     * rotating half a room, AND it can no longer do so silently. Weakening
     * either half re-ships one of the two bugs. */
    const guard = src.indexOf('if (error || !chunk)');
    expect(guard, 'the failed-page guard must still exist').toBeGreaterThan(-1);
    const branch = src.slice(guard, src.indexOf('seats.push(...chunk)', guard));
    // It still declines the pass - rotating a half-read room is the old bug.
    expect(branch).toMatch(/\breturn;/);
    // ...and it is never silent again - the 2026-09-09 bug.
    expect(branch).toContain('HorseSessionRotator.seat_read_failed');
    expect(branch).toContain('console.warn(');
  });

  it('names its foreign key, so a new relationship cannot kill the read', () => {
    /* ADDED 2026-09-09. `table_seats` gained two composite foreign keys to
     * `tables` in one afternoon and the unqualified embed died on the spot.
     * Naming the parent makes the read immune to how many relationships
     * exist between the two tables, which is not something this file should
     * have to learn again from an outage. */
    expect(src).toContain('tables!table_seats_table_id_fkey!inner(');
    const code = src;
    expect(code, 'no unqualified tables embed may come back').not.toMatch(
      /[^!_a-zA-Z]tables!inner\(/
    );
  });
});

describe('horseLoadMap counts every horse, or admits it cannot', () => {
  const src = code(read('services/TournamentRecurringService.ts'));

  it('neither half carries a 20000-row ceiling any more', () => {
    expect(src).not.toMatch(/\.limit\(20000\)/);
  });

  it('pages the live-seat half and the registration half alike', () => {
    const pages = src.match(/\.range\(page \* PAGE/g) ?? [];
    expect(pages.length, 'both halves should page').toBeGreaterThanOrEqual(2);
  });

  it('a failed read is still UNKNOWN - the contract that stops double-booking', () => {
    expect(src).toMatch(/horse_load_seats_failed/);
    expect(src).toMatch(/horse_load_registrations_failed/);
  });

  it('the same-tournament entrant guard cannot be defeated by a big field', () => {
    expect(src).toMatch(/ENTRANT_PAGE/);
    expect(src).toMatch(/if \(alreadyIn\.length < ENTRANT_PAGE\) break;/);
  });
});

describe('the waitlist offer walks the queue instead of peeking at ten', () => {
  /* THE RULE IS UNCHANGED. WHERE IT LIVES CHANGED (2026-08-30).
   *
   * This used to pin a paging loop in TypeScript: `QUEUE_PAGE`, `.range(page *
   * QUEUE_PAGE ...)`, walking until a human turned up. That loop existed
   * because the original code read the ten oldest rows and gave up if all ten
   * were horses — on a deliberately horse-seeded queue, the expected shape.
   *
   * The whole sequence is now `fn_offer_open_seat`, one transaction, for a
   * reason paging never addressed: between reading the queue head and claiming
   * it, a concurrent opener could take the same row and the loser's seat went
   * UNOFFERED in silence. In SQL there is no page to get wrong — `ORDER BY
   * created_at ... FOR UPDATE SKIP LOCKED LIMIT 1` walks the whole queue by
   * construction and hands a concurrent caller the next person instead of a
   * collision.
   *
   * So the assertions follow the rule into the migration rather than being
   * deleted. Both halves of the original are still pinned: no ceiling, and no
   * ambiguous embed.
   */
  const ts = code(read('services/supabase/seats.ts'));
  // process.cwd() is server/ when vitest runs here, matching `read` above.
  const MIGRATIONS = resolve(process.cwd(), '../supabase/migrations');
  const file = readdirSync(MIGRATIONS).find((f) => f.includes('offer_open_seat'));
  const sql = file ? readFileSync(join(MIGRATIONS, file), 'utf8') : '';

  it('the offer is one transaction, not a read the caller can lose a race on', () => {
    expect(ts).toMatch(/rpc\('fn_offer_open_seat'/);
    expect(ts).not.toMatch(/QUEUE_PAGE/);
    expect(ts).not.toMatch(/from\('table_waitlist'\)/);
  });

  it('no longer takes only the oldest ten and hopes a human is among them', () => {
    expect(sql, 'the offer migration is missing').not.toBe('');
    expect(sql).toMatch(/ORDER BY w\.created_at/);
    expect(sql).toMatch(/FOR UPDATE OF w SKIP LOCKED/);
    // The claim takes ONE row after ordering the whole queue. A ceiling on the
    // rows CONSIDERED is what the old bug was.
    expect(sql).not.toMatch(/LIMIT 10\b/);
  });

  it('keeps the unambiguous join - an ambiguous embed could silence offers entirely', () => {
    // table_waitlist.user_id has FKs to BOTH profiles and auth.users, so
    // `profiles!inner(...)` is ambiguous; a 400 there would return null data
    // and stop every seat offer silently. In SQL the join is explicit, which
    // is why the two-query dance is no longer needed.
    expect(ts).not.toMatch(/profiles!inner/);
    expect(sql).toMatch(/JOIN public\.profiles p ON p\.id = w\.user_id/);
  });
});
