/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A MIGRATION VERSION IS RESERVED, NOT GUESSED (2026-09-04)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * A migration version was a 14-digit timestamp each agent typed by hand. There
 * is no coordination in that, and there are a lot of agents: `git worktree
 * list` routinely shows 40-80 live trees off this clone and origin carries 458
 * branches. Two agents starting in the same minute pick the same second, and
 * the second one to push takes the name out from under the first.
 *
 * On 2026-09-04 that happened TWICE IN ONE DAY to a single agent, which is what
 * prompted this. It is also already visible on main:
 *
 *   list the version prefixes in supabase/migrations, sort, and show the
 *   duplicates - the result is not empty
 *
 * and `20260831235992` (a 92nd second) and `20260831b` are what agents reached
 * for once the obvious name was taken. The related failure is in the git log
 * already: #2804, "recover the eleven migrations that were live but absent
 * from git".
 *
 * `scripts/reserve-migration-version.sh` makes the version something you are
 * GIVEN rather than something you choose. It reads three sources - this tree,
 * origin/main via ls-tree, and every sibling worktree on this machine - and the
 * third is the one that matters, because a sibling agent's migration is not on
 * origin yet and no amount of fetching will reveal it.
 *
 * THE LAW. The script exists, is executable, refuses an unreadable slug, never
 * hands out a version that any of those three sources already holds, and
 * CREATES the file - because a reservation nobody can see is not a reservation.
 *
 * Registry: docs/laws.d/a-migration-version-is-reserved-not-guessed.md
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/reserve-migration-version.sh');
const MIG_DIR = resolve(ROOT, 'supabase/migrations');

const created: string[] = [];

function reserve(slug: string): string {
  const out = execFileSync('bash', [SCRIPT, slug], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, RESERVE_MIGRATION_SKIP_FETCH: '1' },
  }).trim();
  created.push(resolve(ROOT, out));
  return out;
}

function versionOf(path: string): string {
  return path.replace(/^.*\//, '').replace(/_.*$/, '');
}

afterEach(() => {
  while (created.length) {
    const f = created.pop()!;
    rmSync(f, { force: true });
  }
});

describe('a migration version is reserved, not guessed', () => {
  it('the script is present and executable', () => {
    // A hook or script committed 644 is skipped and says nothing about it -
    // see AGENT-PLAYBOOK 5b. Same failure shape, so pin the mode.
    expect(() => accessSync(SCRIPT, constants.X_OK)).not.toThrow();
    expect(statSync(SCRIPT).mode & 0o111).toBeTruthy();
  });

  it('refuses a slug that would be unreadable in a directory of 2,121', () => {
    for (const bad of ['fix', 'update', 'Bad-Slug', 'CAPS_SLUG', '']) {
      expect(() =>
        execFileSync('bash', [SCRIPT, bad], {
          cwd: ROOT,
          stdio: 'pipe',
          env: { ...process.env, RESERVE_MIGRATION_SKIP_FETCH: '1' },
        })
      ).toThrow();
    }
  });

  it(
    'creates the file it reserved, so the next caller can see the reservation',
    { timeout: 30_000 },
    () => {
      const path = reserve('a_reservation_that_can_be_seen');
      const abs = resolve(ROOT, path);
      expect(() => statSync(abs)).not.toThrow();
      // And it carries the 10.9 reminder rather than being empty.
      expect(readFileSync(abs, 'utf8')).toMatch(/CLAUDE\.md 10\.9/);
    }
  );

  it('never hands out a version this tree already holds', { timeout: 30_000 }, () => {
    // Squat every second in a two-minute band around now, so whatever the
    // script's first choice is, it is taken and it MUST fall back. Without
    // this the natural timestamp is always free and the fallback never runs.
    mkdirSync(MIG_DIR, { recursive: true });
    const squatted: string[] = [];
    const now = Date.now();
    for (let d = -30_000; d <= 90_000; d += 1000) {
      const t = new Date(now + d);
      const v =
        t.getUTCFullYear().toString() +
        String(t.getUTCMonth() + 1).padStart(2, '0') +
        String(t.getUTCDate()).padStart(2, '0') +
        String(t.getUTCHours()).padStart(2, '0') +
        String(t.getUTCMinutes()).padStart(2, '0') +
        String(t.getUTCSeconds()).padStart(2, '0');
      const f = resolve(MIG_DIR, `${v}_squatter_holding_this_second.sql`);
      writeFileSync(f, '-- squatter\n');
      squatted.push(f);
    }
    try {
      const path = reserve('a_second_agent_wants_the_same_second');
      const taken = new Set(squatted.map((f) => versionOf(f)));
      expect(taken.has(versionOf(path))).toBe(false);
    } finally {
      for (const f of squatted) rmSync(f, { force: true });
    }
  });

  it('two consecutive reservations never collide', { timeout: 30_000 }, () => {
    const a = reserve('the_first_agent_reserves_a_name');
    const b = reserve('the_second_agent_reserves_a_name');
    expect(versionOf(a)).not.toEqual(versionOf(b));
  });
});
