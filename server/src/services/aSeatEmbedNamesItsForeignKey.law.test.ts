/**
 * LAW: an embed between `table_seats` and `tables` names the foreign key.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `table_seats` carries THREE foreign keys to `tables` since 2026-09-09:
 *
 *   table_seats_table_id_fkey       (table_id)                     -> tables(id)
 *   active_seat_game_scope_parent   (table_id, active_game_scope)  -> tables(id, seat_game_scope)
 *   live_seat_parent_cannot_close   (table_id, active_parent_key)  -> tables(id, seat_admission_key)
 *
 * PostgREST resolves an embed by relationship, and with more than one it
 * refuses the whole request: PGRST201, "Could not embed because more than one
 * relationship was found for 'table_seats' and 'tables'". A bare
 * `tables!inner(...)` or `table_seats(...)` in a `.select()` therefore stopped
 * working the moment migration 20260909052547 landed, at 05:25 UTC.
 *
 * What that cost, measured on the engine at 20:30 UTC the same day:
 *
 *   - every tournament start failed in `creditSeatStacks` ("Tournament
 *     live-seat inventory read failed"): 379 tournaments stuck in REGISTERING
 *     with a start time in the past, 591 horse seats frozen on tables that
 *     never dealt a hand, ~800 horses carrying bookings the four-game limit
 *     counted against them, and a cash floor the fleet could not fill because
 *     the horses that could sit were "committed to four games";
 *   - `HorseSessionRotator` read the same embed, hit the same refusal and
 *     returned SILENTLY every cycle - no session ended, no horse rotated;
 *   - `TournamentRecurringService.horseLoadMap` failed ~1,500 times in twenty
 *     minutes, so no horse was registered for anything;
 *   - the knockout candidate veto and the seat claim read it too.
 *
 * The lobby (#3982) was corrected; the engine was not. This law reads every
 * non-test source file under server/src and refuses an embed in either
 * direction that does not carry a `!<constraint name>` hint. The hint form
 * PostgREST accepts is `tables!table_seats_table_id_fkey!inner(...)` - the
 * constraint name first, then `!inner` if the join is inner.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...sourcesUnder(full));
    } else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** The three relationships PostgREST knows between the two tables. */
export const SEAT_TABLE_FOREIGN_KEYS = [
  'table_seats_table_id_fkey',
  'active_seat_game_scope_parent',
  'live_seat_parent_cannot_close',
] as const;

/**
 * An embed of `tables` or `table_seats` inside a select string: the resource
 * name, optionally preceded by an alias (`seats:`), optionally followed by
 * `!hint` segments, then `(`. Only string literals are scanned - a `tables(`
 * outside quotes is a function call or a log label, not a select.
 */
const STRING_LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const EMBED = /(?:^|[\s,(])(?:[A-Za-z_]+:)?(tables|table_seats)((?:![A-Za-z_]+)*)\(/g;

/** Comments are prose, and prose holds apostrophes that would otherwise open
 *  a "string" running to the next one. Stripped before the literals are read. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

export function unhintedSeatEmbeds(source: string): string[] {
  const out: string[] = [];
  for (const literal of withoutComments(source).match(STRING_LITERAL) ?? []) {
    for (const m of literal.matchAll(EMBED)) {
      const hints = m[2].split('!').filter(Boolean);
      const named = hints.some((h) => (SEAT_TABLE_FOREIGN_KEYS as readonly string[]).includes(h));
      if (!named) out.push(m[0].trim());
    }
  }
  return out;
}

describe('LAW: an embed between table_seats and tables names its foreign key', () => {
  const files = sourcesUnder(SRC);

  it('scans the engine source', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  for (const file of files) {
    const rel = relative(SRC, file);
    it(`${rel} names the relationship on every seat/table embed`, () => {
      const offenders = unhintedSeatEmbeds(readFileSync(file, 'utf8'));
      expect(
        offenders,
        `${rel} embeds table_seats<->tables without naming the foreign key. ` +
          `table_seats has three foreign keys to tables, so PostgREST refuses the ` +
          `un-hinted embed (PGRST201) and every caller of this read fails. Write ` +
          `tables!table_seats_table_id_fkey!inner(...) or ` +
          `table_seats!table_seats_table_id_fkey(...). Found: ${offenders.join(' | ')}`
      ).toEqual([]);
    });
  }

  it('the detector sees the shapes that broke production', () => {
    expect(unhintedSeatEmbeds(`.select('user_id, tables!inner(status, tournament_id)')`)).toEqual([
      'tables!inner(',
    ]);
    expect(unhintedSeatEmbeds(`.select('id, seats:table_seats(user_id)')`)).toEqual([
      'seats:table_seats(',
    ]);
    expect(
      unhintedSeatEmbeds(`.select('user_id, tables!table_seats_table_id_fkey!inner(status)')`)
    ).toEqual([]);
    expect(
      unhintedSeatEmbeds(
        `.select('current_players,seats:table_seats!table_seats_table_id_fkey(user_id)')`
      )
    ).toEqual([]);
    // Not a select: a log label, a function call.
    expect(unhintedSeatEmbeds('console.log(`Tournament.${label}.tables(${id})`)')).toEqual([]);
    expect(unhintedSeatEmbeds(`const n = tables(x);`)).toEqual([]);
    // Prose: a select string never puts a space before its parenthesis.
    expect(
      unhintedSeatEmbeds(`console.log('closed all running cash tables (horse fleet disabled)')`)
    ).toEqual([]);
  });
});
