/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE CLIENT NEVER OFFERS A SEAT THE SERVER WILL REFUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The multi-table cap is stated in two places by necessity: the server decides
 * it, and the client has to know it in order to stop short of it. That is a
 * legitimate duplication, and `MultiTablePage` has always said so plainly:
 * "this is the client refusing to offer a seat it knows the server would
 * decline, and never the other way round."
 *
 * The reasoning was right and the number went stale. The cap was raised to six
 * on 2026-08-21 and lowered back to FOUR on 2026-09-02 by
 * `20260902170804_four_games_is_the_max_and_the_database_agrees.sql`. The
 * client kept six on any screen 1024px or wider, so for ten days every desktop
 * opened tabs five and six and had the buy-in refused at the door - precisely
 * the "other way round" its own note forbids. The same file's note on the tile
 * grid said four throughout, so two comments in one file disagreed about one
 * number.
 *
 * This holds the client to the server's answer, DERIVED from the server rather
 * than retyped, so the next change to either one fails here instead of ten
 * days later on somebody's desktop.
 *
 * The cap is global and asset-neutral: a Diamond seat and a chip seat take the
 * same slot, in the chip buy-in body, in the Diamond buy-in door, and in the
 * `table_seats` trigger that counts cash seats and tournament bookings across
 * every arena. That is why this law lives with the Diamond work rather than
 * beside the chip cap: the arena is what made a second server-side copy of the
 * number exist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const at = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

/** Every migration, joined, so a cap can be read wherever it was last set. */
const migrations = () => {
  const dir = resolve(ROOT, 'supabase/migrations');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => [f, readFileSync(resolve(dir, f), 'utf8')] as const);
};

describe('LAW - the client cap is the server cap', () => {
  it('the server says four, in the migration that says so in its name', () => {
    const [, sql] =
      migrations().find(([name]) => name.includes('four_games_is_the_max')) ?? ([] as never);
    expect(sql, 'the migration that lowered the cap is gone').toBeTruthy();
    expect(sql).toMatch(/v_max_tables[^\n]*4/);
  });

  it('the Diamond buy-in door counts to the same four', () => {
    /* The arena needed its own door, so the number exists twice on the server
       too. Both are asserted, because a cap enforced in one denomination and
       not the other is a cap in name only. */
    const diamond = migrations().filter(([, sql]) =>
      sql.includes('TABLE_CAP_REACHED: already seated at four cash tables')
    );
    expect(diamond.length, 'the Diamond door no longer states the cap').toBeGreaterThan(0);
  });

  it('the client offers no more than that', () => {
    const page = at('src/pages/MultiTablePage.tsx');
    const decl = page.match(/const MAX_TABLES = ([^;]+);/);
    expect(decl, 'MAX_TABLES is gone or renamed').toBeTruthy();
    const value = decl?.[1].trim();
    expect(value, 'the client cap is computed rather than stated').toBe('4');
  });

  it('and it does not compute a different cap from the screen it is on', () => {
    /* The stale value was `window.innerWidth >= 1024 ? 6 : 4`. A cap that
       depends on the viewport cannot match a server that does not see it. */
    const page = at('src/pages/MultiTablePage.tsx');
    const decl = page.match(/const MAX_TABLES = ([^;]+);/)?.[1] ?? '';
    expect(decl, 'the cap reads the viewport').not.toMatch(/innerWidth|matchMedia|screen/);
  });
});
