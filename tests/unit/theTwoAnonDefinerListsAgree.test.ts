import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * THE TWO ANON-DEFINER LISTS DESCRIBE ONE FACT, SO THEY MUST AGREE
 *
 * Found 2026-09-22, in the `Live drift and BBJ rebuild coverage remain clean`
 * job of `Production Integrity Audit`, which had been red on `main` since the
 * 19th:
 *
 *     ANON MAY EXECUTE 1 DEFINER FUNCTION(S) THIS REPOSITORY HAS NOT
 *     ACCOUNTED FOR:
 *        fn_shared_bonus_replay(p_share_id uuid)
 *
 * The grant was not a mistake. Migration 20260919153418 makes it deliberately,
 * asserts it in its own postcondition, and raises if it is absent: a shared
 * replay link is meant to open for a logged-out visitor. Nobody was careless.
 *
 * TWO LISTS HAD TO AGREE AND NOTHING CHECKED THEM (CLAUDE.md 10.84, the same
 * shape as the three monitoring lists on engine-01):
 *
 *   1. `scripts/ci/definer-authorization.allowlist.json` -> `anonPublicSurface`
 *      is the STATIC list. `check-definer-authorization.mjs` reads it from the
 *      migration text, pre-push and in PR CI, BEFORE the merge.
 *   2. `docs/security/anon-executable-definers.json` -> `allowed[]` is the LIVE
 *      list. `check-anon-definer-grants.mjs` reads it against production's real
 *      grants, hourly, AFTER the merge.
 *
 * The migration author correctly added the first one, which is the list that
 * was standing between them and a green push. The second one is only ever
 * consulted by a job that runs after the merge has already happened, so nothing
 * they could run locally would have told them it was missing - and the audit
 * that did notice writes to an issue, not to a check anybody had to clear.
 *
 * This pin closes that gap with no database and no credential: every name the
 * static list blesses must also be accounted for in the live list. It runs
 * wherever `tests/` runs - `.husky/pre-push`, PR CI, and the `npx vitest run
 * tests/` gate inside `publish-club-arena.yml` - so the NAMED READER is the
 * author of the very branch that adds the grant, at the moment they add it,
 * which is the only moment the fix is cheap.
 *
 * It deliberately does not check the other direction. The live list legitimately
 * holds long-standing grants that no current branch declares, and the static
 * list "starts EMPTY on purpose" by its own comment. Requiring the live list to
 * be a subset of the static one would demand grandfathering the entire existing
 * public surface into a list whose whole point is that each entry cost somebody
 * a paragraph of thought.
 */

const STATIC_LIST = JSON.parse(
  readFileSync('scripts/ci/definer-authorization.allowlist.json', 'utf8')
) as { anonPublicSurface?: unknown };

const LIVE_LIST = JSON.parse(
  readFileSync('docs/security/anon-executable-definers.json', 'utf8')
) as { allowed: Array<{ fn: string; reason?: string }> };

/** `anonPublicSurface` is an array of bare function names, or an object keyed by them. */
function staticNames(): string[] {
  const surface = STATIC_LIST.anonPublicSurface;
  if (Array.isArray(surface)) return surface.map(String);
  if (surface && typeof surface === 'object') return Object.keys(surface);
  return [];
}

/** The live list stores full signatures; the static one stores bare names. */
function liveNames(): Set<string> {
  return new Set(LIVE_LIST.allowed.map((e) => e.fn.replace(/\(.*$/, '').trim()));
}

describe('the two anon-definer lists agree', () => {
  it('every function the static allowlist blesses is accounted for in the live manifest', () => {
    const missing = staticNames().filter((n) => !liveNames().has(n));
    expect(
      missing,
      'These are on anonPublicSurface, so a branch may ship them anon-executable, but ' +
        'docs/security/anon-executable-definers.json does not account for them - so the ' +
        'hourly Production Integrity Audit will go red on main after the merge. Add an ' +
        'entry naming what a logged-out caller is allowed to learn, or revoke the grant.'
    ).toEqual([]);
  });

  it('keeps the live manifest usable as the anonymous attack surface it claims to be', () => {
    // An empty allowlist is a broken scan, not a clean one - the reader in
    // check-anon-definer-grants.mjs throws on exactly this, and the guard is
    // worthless if this file is ever emptied to make something go green.
    expect(LIVE_LIST.allowed.length).toBeGreaterThan(0);
    for (const entry of LIVE_LIST.allowed) {
      expect(entry.fn, 'every entry names a full function signature').toMatch(
        /^[a-z_][a-z0-9_]*\(/i
      );
      expect(
        String(entry.reason ?? ''),
        `${entry.fn} must say why anon may execute it`
      ).not.toMatch(/^\s*$|UNREVIEWED/);
    }
  });

  it('accounts for fn_shared_bonus_replay, the grant that made this pin necessary', () => {
    expect(liveNames().has('fn_shared_bonus_replay')).toBe(true);
    expect(staticNames()).toContain('fn_shared_bonus_replay');
  });
});
