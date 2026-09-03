/**
 * LAW: a tool the rules forbid does not sit where an agent will find it.
 *
 * CLAUDE.md 1.3 already established the principle, when scripts/antigravity-
 * deploy.sh was deleted rather than merely banned: "a file the rules name as
 * forbidden, sitting where an agent will find it, is a trap." An agent reads
 * the repo before it reads the rules, and a working script beats a paragraph.
 *
 * Two more were still there on 2026-09-03:
 *
 * 1. `wait_for_pr_and_deploy.sh` - CLAUDE.md 10.8.3 names this exact pattern
 *    as forbidden ("NEVER SET A TIMER TO WATCH CI ... the forbidden
 *    wait_for_pr_and_deploy.sh written in prose"). The rule against it was in
 *    the file; so was the script.
 *
 * 2. `.github/workflows/apply-migration-temp.yml` - a one-off from 2026-08-23
 *    that ran three times, failed all three, and was left behind. It held
 *    SUPABASE_DB_PASSWORD and applied two hardcoded .sql files to PRODUCTION
 *    with `psql -f`. That bypasses supabase_migrations entirely, so schema
 *    applied through it is invisible to `list_migrations` and to
 *    applied-migrations-recorded.yml - the exact class of "live in production,
 *    absent from the ledger" this estate keeps having to chase. It fired on
 *    push to one branch name, which makes it a landmine rather than a tool.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');

describe('forbidden tools stay deleted', () => {
  const gone = ['wait_for_pr_and_deploy.sh', '.github/workflows/apply-migration-temp.yml'];

  for (const f of gone) {
    it(`${f} does not come back`, () => {
      expect(existsSync(join(ROOT, f))).toBe(false);
    });
  }

  it('no workflow applies SQL to production with psql -f', () => {
    // The migration ledger is the whole audit trail. Anything that writes
    // schema outside apply_migration is invisible to every guard we have.
    const hits = execSync(
      'grep -rl "psql .*-f .*supabase/migrations" .github/workflows/ 2>/dev/null || true',
      { cwd: ROOT, encoding: 'utf8' }
    ).trim();
    expect(hits).toBe('');
  });
});
