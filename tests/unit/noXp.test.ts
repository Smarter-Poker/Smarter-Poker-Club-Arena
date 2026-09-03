/**
 * XP STAYS GONE.
 * ============================================================================
 * XP was removed as a product decision roughly eight months ago. The database
 * enforces it with an event trigger, xp_ban_guard, which rejects any DDL that
 * would create an XP-shaped column, table or function.
 *
 * What nobody noticed is that one XP column SURVIVED the removal -
 * club_members.reputation_xp - and because the guard fires on any DDL against
 * a table holding such a column, it made club_members undeployable. Every
 * attempt to change a constraint on the single most-edited table in the club
 * system failed with an error about XP. The platform's own health check,
 * verify_home_games_health, asserts "zero XP columns" and had therefore been
 * reporting a failure the whole time.
 *
 * The column is gone, and so are the two tombstone RPCs (fn_award_social_xp,
 * which was `BEGIN RETURN; END`, and get_user_total_xp, which was
 * `BEGIN RETURN 0; END`).
 *
 * This guards the client half: no XP field names, and no calls to XP RPCs.
 * The database half is guarded by xp_ban_guard, which stays exactly where it
 * is - it is the thing keeping XP out, not a thing to be removed with it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOTS = [resolve(__dirname, '../../src'), resolve(__dirname, '../../server/src')];

/** Code only: the comments explaining the removal must not trip the guard. */
const stripComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // server/src may not exist in every checkout
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(r));

describe('XP stays gone', () => {
  it('finds source to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('no XP-shaped field name survives', () => {
    // The same shapes xp_ban_guard rejects in the database.
    const banned =
      /\b(reputation_xp|total_xp|xp_total|xp_earned|xp_reward|social_xp|bonus_xp_\w+)\b/;
    const offenders: string[] = [];
    for (const f of files) {
      if (banned.test(stripComments(readFileSync(f, 'utf8')))) {
        offenders.push(relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      'XP was removed as a product decision. A column of it surviving is what ' +
        'made club_members undeployable for months.'
    ).toEqual([]);
  });

  it('nothing calls an XP rpc', () => {
    const banned =
      /rpc\(\s*['"](fn_award_social_xp|get_user_total_xp|award_xp|add_xp|grant_xp)['"]/;
    const offenders: string[] = [];
    for (const f of files) {
      if (banned.test(stripComments(readFileSync(f, 'utf8')))) {
        offenders.push(relative(process.cwd(), f));
      }
    }
    expect(offenders, 'Both XP RPCs were dropped; a call to one now errors.').toEqual([]);
  });

  it('no query selects or orders by an XP column', () => {
    const banned = /(select|order)\(\s*[`'"][^`'"]*reputation_xp/i;
    const offenders: string[] = [];
    for (const f of files) {
      if (banned.test(stripComments(readFileSync(f, 'utf8')))) {
        offenders.push(relative(process.cwd(), f));
      }
    }
    expect(
      offenders,
      'Selecting a dropped column returns 42703 and fails the whole query.'
    ).toEqual([]);
  });
});
