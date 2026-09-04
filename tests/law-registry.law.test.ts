/**
 * LAW: every law has exactly one registry row, and the registry has no ghosts.
 * ═══════════════════════════════════════════════════════════════════════════
 * Created 2026-09-01 after the hamburger-menu revert war (#2321 -> #2401 ->
 * #2429 -> #2432). Two law tests demanding opposite artwork coexisted in
 * different (stale) worktrees, and each agent that read one re-reverted the
 * other's work — for two days, on a loop, with CI billing every round trip.
 *
 * docs/LAWS.md is the single place where every binding law is visible at
 * once, which is the only arrangement in which a CONTRADICTION is visible at
 * all. This test makes the registry load-bearing:
 *
 *   - a `*.law.test.*` file that is not registered fails here, with
 *     instructions, in the same PR that adds it;
 *   - a registry row whose file is gone fails here too, so retiring a law is
 *     a visible two-part diff (delete the test AND its row), never a silent
 *     disappearance.
 *
 * If you are here because you want to ADD a law: add one row to the table in
 * docs/LAWS.md in this same commit. If you are here because your new law
 * CONTRADICTS a registered one: stop — do not write a third law, do not
 * delete the old one on your own authority. Ask Dan, record the ruling under
 * "Resolved conflicts", and land the winner and the deletion together.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const REGISTRY_PATH = join(ROOT, 'docs', 'LAWS.md');

function lawFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...lawFilesUnder(full));
    else if (/\.law\.test\.\w+$/.test(entry.name)) out.push(relative(ROOT, full));
  }
  return out;
}

/**
 * THE REGISTRY MUST SEE EVERY LAW, NOT ONLY THE ONES UNDER tests/ (2026-09-02).
 *
 * This scanned `tests/` alone, so 26 of the 28 law tests living under
 * `server/src/` were invisible to it — among them `payoutExactness`,
 * `EveryEarnerIsPaid`, `aGuaranteeIsAPromise`, `aTournamentPayoutIsARecord`
 * and `theReconcilerTrustsWhatItCanProve`. Every one of those guards money.
 *
 * That is precisely the failure this registry exists to prevent. It was built
 * after the hamburger revert war so a law could not be silently contradicted
 * or deleted — and it could not see the laws protecting payouts. A deletion
 * there would have passed CI without a word.
 *
 * Both roots are scanned now, and the ghost check below matches both prefixes
 * so a retired law under `server/src/` also has to lose its row visibly.
 */
const LAW_ROOTS = ['tests', 'server/src'];

/**
 * 2026-09-04: THE TABLE MOVED OUT OF docs/LAWS.md INTO docs/laws.d/, ONE FILE
 * PER LAW. Every law appended a row to the same last line of the same file,
 * so any two law-bearing pull requests conflicted with each other there and
 * nowhere else - one PR went merge-dirty four times in an afternoon on that
 * table alone. Same disease as MIGRATION-CHANGELOG.md (CLAUDE.md 10.9), same
 * cure. The rules are unchanged; "a row" is now "a file".
 */
const LAWS_DIR = join(ROOT, 'docs', 'laws.d');

function registryEntries(): Map<string, { file: string; guard: string }> {
  const out = new Map<string, { file: string; guard: string }>();
  for (const f of readdirSync(LAWS_DIR)) {
    if (!f.endsWith('.md')) continue;
    const [head, ...rest] = readFileSync(join(LAWS_DIR, f), 'utf8').split('\n');
    const path = head.replace(/^#\s*/, '').trim().replace(/\\/g, '/');
    out.set(path, { file: `docs/laws.d/${f}`, guard: rest.join(' ').trim() });
  }
  return out;
}

function slugFor(file: string): string {
  return file
    .replace('.law.test', '')
    .replace(/\.\w+$/, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

describe('the law registry (docs/laws.d/, one file per law)', () => {
  const registry = readFileSync(REGISTRY_PATH, 'utf8');
  const entries = registryEntries();
  const lawFiles = LAW_ROOTS.flatMap((root) => lawFilesUnder(join(ROOT, root))).map((p) =>
    p.replace(/\\/g, '/')
  );

  it('docs/LAWS.md still carries the rules and points at the directory', () => {
    expect(registry).toContain('## Registry');
    expect(registry).toContain('docs/laws.d/');
    // The table must NOT come back here: that is the conflict magnet.
    expect(registry).not.toMatch(/^\|\s*(?:tests|server\/src)\/\S+\.law\.test\.\w+\s*\|/m);
  });

  it.each(lawFiles)('%s is registered in docs/laws.d/', (file) => {
    const entry = entries.get(file);
    expect(
      entry !== undefined,
      `${file} is a law test but has no registry file. Create ` +
        `docs/laws.d/${slugFor(file)}.md in this same commit, containing:\n` +
        `# ${file}\n\n<one line: what it guards>`
    ).toBe(true);
    expect(entry!.guard.length, `${entry!.file} must say what the law guards`).toBeGreaterThan(10);
  });

  it('lists no law file that does not exist (retire laws visibly)', () => {
    const ghosts = [...entries.entries()].filter(([path]) => !lawFiles.includes(path));
    expect(
      ghosts.map(([path, e]) => `${e.file} -> ${path}`),
      `docs/laws.d/ names law files that no longer exist. If the law was ` +
        `deliberately retired, delete its registry file in the same PR that ` +
        `deleted the test; if it was not, the deletion is a regression - restore it.`
    ).toEqual([]);
  });

  it('every registry file names exactly one law, on its first line', () => {
    for (const f of readdirSync(LAWS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const head = readFileSync(join(LAWS_DIR, f), 'utf8').split('\n')[0];
      expect(head, `${f} must start with "# <law test path>"`).toMatch(
        /^#\s*(tests|server\/src)\/\S+\.law\.test\.\w+\s*$/
      );
    }
  });

  it('the hamburger ruling stays settled: the counter-law must not return', () => {
    // Dan's ruling, recorded 2026-09-01: "em bars" means em dashes, not menu
    // artwork. The banned counter-law took the menu off every page twice.
    expect(lawFiles.some((f) => /noThreeBarArtwork/i.test(f))).toBe(false);
    expect(registry).toContain('Resolved conflicts');
  });
});
