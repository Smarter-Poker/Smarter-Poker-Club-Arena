/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: A SCRIPT NEVER WEARS A PERSON'S FACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04, twice in one hour: "DON'T USE MY ACCOUNT FOR THE CRON ...
 * KEEP MY ACCOUNT CLEAN." and "Do not hardcode any credentials. Always read
 * from the .env.local files."
 *
 * WHY. A World Hub cron was signing in as his personal account and calling a
 * bare signOut() - global scope - every 15 minutes, revoking every session
 * he had and parking every table he opened on "Reconnecting To The Table"
 * for 22 hours. When I looked for the same shape in THIS repo I found four
 * scripts defaulting to his personal address (three audit scripts and
 * reset_test_user.ts, which sets that account's display name to "New
 * Player"), and .env.example telling every new clone to do the same.
 *
 * THE PINS
 *   1. No headless code (scripts/, e2e-live/, tests/e2e/support/, server/,
 *      root-level scripts, .github/) calls `auth.signOut(` without
 *      `scope: 'local'`. A person choosing Log Out in the UI may sign out
 *      everywhere; a script may not. (The World Hub carries the same law:
 *      __tests__/synthetic-probes-never-sign-out-a-person.law.test.mjs.)
 *   2. Dan's personal address appears in no source file outside docs/ and
 *      comments - not as a default, not as a fallback, not in
 *      .env.example. The account a script uses comes from the environment
 *      (SP_EMAIL / TEST_USER_EMAIL in .env.local), and a script without one
 *      refuses to guess.
 *
 * IF THIS FILE GOES RED, YOUR CHANGE IS THE BUG. Do not add the address back
 * "just as a default". Do not add an allowlist.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const PERSONAL = ['daniel@', 'bekavactrading', '.com'].join('');

const HEADLESS_DIRS = ['scripts', 'e2e-live', 'tests/e2e/support', 'server/src', '.github'];
const ROOT_SCRIPTS = readdirSync(ROOT).filter(
  (n) => /\.(m?js|cjs|ts)$/.test(n) && !n.includes('.config.')
);
const SOURCE_EXT = /\.(m?js|cjs|ts|tsx|sh|ya?ml|json|example)$/;
const SKIP = new Set(['node_modules', 'dist', '.next', 'build', '_archive', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXT.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** `.auth.signOut(` call sites with their argument text, comments stripped. */
export function signOutCallSites(source: string): string[] {
  const s = stripComments(source);
  const sites: string[] = [];
  const re = /\.auth\.signOut\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < s.length && depth > 0) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') depth--;
      i++;
    }
    sites.push(s.slice(re.lastIndex, i - 1).trim());
  }
  return sites;
}

describe('LAW 1 - headless code never signs a user out globally', () => {
  it('every auth.signOut( in scripts, e2e support, server and workflows carries scope local', () => {
    const offenders: string[] = [];
    const files = [
      ...HEADLESS_DIRS.flatMap((d) => walk(join(ROOT, d))),
      ...ROOT_SCRIPTS.map((n) => join(ROOT, n)),
    ];
    for (const file of files) {
      if (!/\.(m?js|cjs|ts|tsx)$/.test(file)) continue;
      if (/\.test\.\w+$/.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (!src.includes('signOut')) continue;
      for (const args of signOutCallSites(src)) {
        if (!/scope\s*:\s*['"]local['"]/.test(args)) {
          offenders.push(`${relative(ROOT, file)}: signOut(${args})`);
        }
      }
    }
    expect(offenders, 'use signOut({ scope: "local" }) - end only the session you created').toEqual(
      []
    );
  });

  it('self-check: the scan sees a bare call and ignores a comment quoting one', () => {
    expect(signOutCallSites('await x.auth.signOut();')).toEqual(['']);
    expect(signOutCallSites("await x.auth.signOut({ scope: 'local' }).catch(() => 0)")).toEqual([
      "{ scope: 'local' }",
    ]);
    expect(signOutCallSites('// x.auth.signOut()\n/* y.auth.signOut() */')).toEqual([]);
  });
});

describe("LAW 2 - Dan's personal account is not a default anywhere", () => {
  it('the address appears in no source, script, workflow or env example (docs and comments excepted)', () => {
    const offenders: string[] = [];
    const dirs = [
      'src',
      'server/src',
      'scripts',
      'e2e-live',
      'tests',
      'e2e',
      '.github',
      'supabase/functions',
    ];
    const files = [
      ...dirs.flatMap((d) => walk(join(ROOT, d))),
      ...ROOT_SCRIPTS.map((n) => join(ROOT, n)),
    ];
    // .env.example is the one non-code file that taught every clone the habit.
    files.push(join(ROOT, '.env.example'));
    for (const file of files) {
      if (file === __filename) continue;
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (!src.includes(PERSONAL)) continue;
      const code = /\.(m?js|cjs|ts|tsx)$/.test(file)
        ? stripComments(src)
        : src.replace(/^\s*#.*$/gm, '');
      if (code.includes(PERSONAL)) offenders.push(relative(ROOT, file));
    }
    expect(
      offenders,
      'read the account from SP_EMAIL / TEST_USER_EMAIL in .env.local instead'
    ).toEqual([]);
    /* A LAW THAT RUNS OUT OF TIME HAS NOT ANSWERED (2026-09-10). This walks
       eight directories plus every root script and reads each file, and it
       lands around 5.2s - just past vitest's 5,000ms default. Measured on
       2026-09-10 it timed out three full-suite runs in a row on a busy Mac
       while every assertion in it would have passed; alone on the same machine
       it finishes in 0.8s.

       `Test timed out in 5000ms` names no cause and proves nothing - the
       assertion never ran. This is a SECURITY law: it is what keeps Dan's
       personal address out of every script after a cron wearing it signed him
       out of every table for twenty-two hours. A security law that flakes is
       one people learn to re-run instead of read (CLAUDE.md 10.86 - a signal
       that answers when it does not know). The budget below is the measurement
       plus headroom, not a guess, and it changes nothing about what is
       asserted. */
  }, 30_000);

  it('the scripts that used to default to it now refuse to run without an account', () => {
    for (const f of [
      'scripts/e2e-avatar-audit.mjs',
      'scripts/e2e-mobile-overflow-audit.mjs',
      'e2e-live/tournament-lobby-audit.mjs',
      'reset_test_user.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf8');
      expect(src, f).toMatch(/refusing to guess an account/);
    }
  });
});
