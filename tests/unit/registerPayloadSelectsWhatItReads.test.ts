/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A PAYLOAD MAY ONLY READ WHAT ITS QUERY SELECTED
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BUG THIS EXISTS FOR (2026-08-25). ClubHomePage's buy-in payload read
 * `is_bounty`, `bounty_amount`, `is_pko` and `is_mystery_bounty` off the
 * tournament row — through `(t as any)` casts, so TypeScript said nothing — and
 * NEITHER of that page's two lobby queries selected them. Every one was
 * `undefined` at runtime, so `bounty_amount` resolved to 0 and the Bounty row
 * simply never appeared on the shared Sign Up card. The page looked correct,
 * the code read correct, and the feature was inert.
 *
 * WHY THE EXISTING GATE CANNOT SEE THIS. `scripts/ci/check-phantom-columns.mjs`
 * runs in CI and is excellent, but it checks the OPPOSITE direction: it catches
 * `.select('a_column_that_does_not_exist')`. Selecting nothing and then reading
 * a field is invisible to it — there is no wrong column name anywhere, only an
 * absent one.
 *
 * WHY NOT JUST TYPE THE CLIENT. `src/lib/supabase.ts` calls `createClient` with
 * no `Database` generic, so every query returns `any` and a generated types file
 * would fix this whole class at a stroke. It is also 1.67 MB of generated
 * source for this schema, it goes stale the day it lands, and switching it on
 * would surface hundreds of errors across every page in the app at once — which
 * is a project, not a test, and emphatically not something to do while four
 * other agents are editing those same files. Recorded here as the real fix,
 * deliberately not attempted; this spec covers the one place it actually bit.
 *
 * WHAT THIS ASSERTS. For each surface that builds a buy-in payload: every
 * tournament field the payload reads must appear in a `.select(...)` string in
 * the same file. Narrow on purpose — a general "reads what it selects" checker
 * across the whole app is a static-analysis problem with a false-positive rate
 * that would get it switched off within a week.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceCall, sliceCall } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/**
 * Fields the shared Sign Up card renders rows from. If a payload reads one of
 * these off the row, the row's query has to have asked for it.
 */
const PAYLOAD_FIELDS = [
  'is_bounty',
  'bounty_amount',
  'is_pko',
  'is_mystery_bounty',
  'start_time',
  'status',
  'club_id',
] as const;

/**
 * Surfaces whose rows come from a Supabase select IN THE SAME FILE.
 *
 * Deliberately excludes:
 *  - TournamentDetails, which loads a whole row via `tournamentService`
 *    (`select('*')`), so there is nothing to under-select;
 *  - TournamentLobbyPage, whose payload reads its own camelCase view model
 *    (`buyInPrize`, `startTime`, `isBounty`) rather than raw columns — the
 *    mapper is the contract there, and TypeScript checks it because that
 *    interface is declared.
 */
const SURFACES = [
  'src/pages/ClubHomePage.tsx',
  /* 2026-08-26, third audit: XMTTPage was NOT here, and it was reading
     is_bounty / bounty_amount / is_pko / is_mystery_bounty off a row whose
     query selected none of them — the exact bug this file exists for, on a
     surface the file excluded. The exclusion note below named only the two
     surfaces that genuinely cannot be checked; XMTT and UnionGames were simply
     forgotten, which is why an exclusion list must name its reasons. */
  'src/pages/XMTTPage.tsx',
  'src/pages/UnionGamesPage.tsx',
];

/**
 * Every column named inside a `.select('...')` that belongs to a TOURNAMENTS
 * query.
 *
 * 2026-08-26, third audit: this used to union the columns of EVERY select in
 * the file — `tables`, `union_clubs`, `bbj_pools` and the rest. `status` and
 * `club_id` are selected by half a dozen non-tournament queries in
 * ClubHomePage, so those two fields could never fail the check even if the
 * tournaments query dropped them entirely. Scope it to the table we are
 * actually reasoning about.
 *
 * A select is attributed to `tournaments` when the nearest preceding `.from(...)`
 * names it. Anything whose table cannot be resolved is SKIPPED rather than
 * guessed, the same conservative rule check-phantom-columns.mjs uses.
 */
function selectedColumns(src: string, table = 'tournaments'): Set<string> {
  const out = new Set<string>();
  // Single- or double-quoted select() arguments. Template literals are dynamic
  // and deliberately skipped, exactly as check-phantom-columns.mjs skips them.
  for (const m of src.matchAll(/\.select\(\s*(['"])([\s\S]*?)\1/g)) {
    const before = src.slice(0, m.index ?? 0);
    const lastFrom = before.lastIndexOf('.from(');
    if (lastFrom === -1) continue;
    const fromArg = sliceCall(before.slice(lastFrom), '.from(').match(/\.from\(\s*['"]([^'"]+)['"]/);
    if (!fromArg || fromArg[1] !== table) continue;
    for (const raw of m[2].split(',')) {
      const col = raw
        .trim()
        // `alias:real_column` -> real_column
        .replace(/^[\w]+\s*:\s*/, '')
        // drop embedded-resource bodies: `clubs(name)` -> clubs
        .replace(/\(.*$/, '')
        .trim();
      if (col) out.add(col);
    }
  }
  return out;
}

describe('a buy-in payload can only read what its own query selected', () => {
  for (const file of SURFACES) {
    it(`${file} selects every tournament field its registerMtt payload reads`, () => {
      const src = read(file);

      const at = src.indexOf('registerMtt(');
      expect(at, `${file} must build a payload`).toBeGreaterThan(-1);
      // The payload object, generously bounded — long enough to cover the whole
      // argument, short enough not to swallow the rest of the component.
      const payload = sliceCall(src, 'registerMtt(');

      const selected = selectedColumns(src);
      expect(selected.size, `${file} must contain at least one .select()`).toBeGreaterThan(0);

      const missing: string[] = [];
      for (const field of PAYLOAD_FIELDS) {
        // Does the payload actually read this field off a row?
        const readsIt = new RegExp(`\\b${field}\\b`).test(payload);
        if (!readsIt) continue;
        // `select('*')` asks for everything.
        if (selected.has('*')) continue;
        if (!selected.has(field)) missing.push(field);
      }

      expect(
        missing,
        `${file} reads ${missing.join(', ')} off the tournament row but never SELECTs ` +
          `${missing.length === 1 ? 'it' : 'them'} — they will be undefined at runtime and ` +
          `the Sign Up card will silently render without those rows`
      ).toEqual([]);
    });
  }

  it('the parser understands aliases and embedded resources', () => {
    // Guarding the guard: a checker that silently matches nothing is worse
    // than no checker, and the alias form is what this codebase actually uses
    // (XMTTPage selects `buy_in:buy_in_amount`).
    const cols = selectedColumns(`
      supabase.from('tournaments').select('id, buy_in:buy_in_amount, clubs(name), status')
    `);
    expect(cols.has('id')).toBe(true);
    expect(cols.has('buy_in_amount'), 'alias must resolve to the real column').toBe(true);
    expect(cols.has('clubs'), 'embedded resource keeps its table name').toBe(true);
    expect(cols.has('status')).toBe(true);
    expect(cols.has('buy_in'), 'the alias name itself is not a column').toBe(false);
  });

  it('the fields it checks are real columns on tournaments', () => {
    /* If a name here were misspelled the loop above would pass vacuously
       forever. Checked against the same manifest the phantom-column CI gate
       uses, so the two cannot drift apart. */
    const manifest = JSON.parse(read('scripts/ci/supabase-columns-manifest.json')) as {
      columns: Record<string, string[]>;
    };
    const cols = new Set(manifest.columns.tournaments || []);
    expect(cols.size, 'the manifest must know the tournaments table').toBeGreaterThan(0);
    for (const f of PAYLOAD_FIELDS) {
      expect(cols.has(f), `tournaments.${f} must be a real column`).toBe(true);
    }
  });
});
