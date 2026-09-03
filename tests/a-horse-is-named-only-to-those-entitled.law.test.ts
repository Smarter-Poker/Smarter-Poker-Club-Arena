import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HORSE IS NAMED ONLY TO THOSE ENTITLED (binding)
 *
 * fn_can_see_horse_flag(club) decides who may know which players are house
 * horses: a platform admin, or an owner / co_owner / admin of that club. The
 * rule is written in the source of the routines that already follow it -
 * "staff get the truth, everyone else gets a uniform false."
 *
 * FOUR browser-reachable routines did not follow it, and three of them were the
 * Club Data players tab, its paging and its CSV export. Those are gated on
 * ca_can_view_club_finances, which admits SUPER_AGENT - a role
 * fn_can_see_horse_flag deliberately excludes. A super agent opening the page
 * was told, per row, which players are horses, and could export the same. The
 * fourth was fn_club_cashier_members_page_v3: its own _v2 masks, and the paged
 * successor written afterwards did not.
 *
 * That second shape is the one worth guarding against, because it is not a
 * mistake anybody makes once. A masked reader gets a paged variant, or a
 * filtered variant, or a v4, and the masking does not come with it. This law
 * therefore does not check a list of four names - it checks that ANY
 * browser-reachable routine returning the flag masks it.
 *
 * WHAT IS DELIBERATELY EXEMPT: routines whose whole subject is horses
 * (ca_horse_*), which are gated on their own caller checks and whose audience
 * already knows. They are named here so an exemption is a decision on the
 * record rather than a gap.
 */

const MIGRATIONS = resolve(__dirname, '../supabase/migrations');

function allMigrations(): string {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(resolve(MIGRATIONS, f), 'utf8'))
    .join('\n');
}

/** The Club Data player path, plus the cashier page that missed it. */
const MUST_MASK = [
  'ca_club_player_breakdown',
  'ca_club_player_page',
  'ca_club_player_export_start',
  'fn_club_cashier_members_page_v3',
];

describe('a horse is named only to those entitled', () => {
  it('a migration exists that masks the four readers that leaked', () => {
    const sql = allMigrations();
    expect(sql).toContain('fn_can_see_horse_flag');
    for (const fn of MUST_MASK) {
      expect(sql, `${fn} is never masked in any migration`).toContain(fn);
    }
  });

  it.each(MUST_MASK)('%s is masked with the estate helper, not a local rule', (fn) => {
    const sql = allMigrations();

    // BOUNDED TO THIS ROUTINE'S BLOCK, and that is the whole difficulty.
    //
    // The first version matched from `proname = 'X'` across the next 900
    // characters, non-greedily, looking for the helper. Removing the masking
    // from ca_club_player_breakdown did not fail it: the search simply ran on
    // into the NEXT routine's rewrite, found the helper there, and passed. A
    // window that spans past the thing under test is testing its neighbour.
    //
    // Each block is delimited by its own guard, which names the routine, so
    // the block can be cut exactly.
    const start = sql.indexOf(`proname = '${fn}'`);
    expect(start, `${fn} is never selected for rewriting`).toBeGreaterThan(-1);
    const end = sql.indexOf(`RAISE EXCEPTION '${fn}:`, start);
    expect(end, `${fn} has no guard closing its block`).toBeGreaterThan(start);

    const block = sql.slice(start, end);
    expect(block, `${fn} is rewritten without fn_can_see_horse_flag`).toContain(
      'fn_can_see_horse_flag'
    );
  });

  it('the rewrite fails loudly rather than silently masking nothing', () => {
    // The migration edits pg_get_functiondef output. If an upstream rename
    // makes the flag expression unmatchable, the replace becomes a no-op and
    // the routine ships unmasked. Every branch raises instead.
    const sql = allMigrations();
    for (const fn of MUST_MASK) {
      expect(sql, `${fn} has no assertion that its rewrite matched`).toMatch(
        new RegExp(`RAISE EXCEPTION '${fn}: horse flag expression not found'`)
      );
    }
  });

  it('the page paints the flag it is given and never derives one', () => {
    // The client must not infer "horse" from a username, an avatar, a member
    // number or anything else. If the database masked it, the screen has to
    // stay masked too - a client-side guess would walk straight around the
    // entitlement the database just enforced.
    const page = readFileSync(resolve(__dirname, '../src/pages/club/ClubDataPage.tsx'), 'utf8');
    const horseLines = page.split('\n').filter((l) => /is_horse|horseTag|hideHorses/.test(l));
    expect(horseLines.length).toBeGreaterThan(0);
    for (const line of horseLines) {
      expect(line, `this line derives a horse rather than reading the flag: ${line}`).not.toMatch(
        /username\s*\.\s*(includes|startsWith|match)|is_bot/
      );
    }
  });

  it('never calls a horse a bot, anywhere the operator can read', () => {
    // Dan, binding: a horse is a horse. The word does not appear in this
    // page's copy, its styles, or the migration that masks the flag.
    const page = readFileSync(resolve(__dirname, '../src/pages/club/ClubDataPage.tsx'), 'utf8');
    const css = readFileSync(
      resolve(__dirname, '../src/pages/club/ClubDataPage.module.css'),
      'utf8'
    );
    for (const [name, body] of [
      ['ClubDataPage.tsx', page],
      ['ClubDataPage.module.css', css],
    ] as const) {
      expect(body, `${name} refers to a horse as a bot`).not.toMatch(/\bbots?\b/i);
    }
  });
});
