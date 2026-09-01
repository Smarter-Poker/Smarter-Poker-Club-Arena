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

describe('the law registry (docs/LAWS.md)', () => {
  const registry = readFileSync(REGISTRY_PATH, 'utf8');
  const lawFiles = lawFilesUnder(join(ROOT, 'tests')).map((p) => p.replace(/\\/g, '/'));

  it('exists and has a registry table', () => {
    expect(registry).toContain('## Registry');
  });

  it.each(lawFiles)('%s is registered in docs/LAWS.md', (file) => {
    expect(
      registry.includes(file),
      `${file} is a law test but has no row in docs/LAWS.md. Add one in this ` +
        `same commit: | ${file} | <one line: what it guards> |`
    ).toBe(true);
  });

  it('lists no law file that does not exist (retire laws visibly)', () => {
    const listed = [...registry.matchAll(/\| (tests\/[^ |]+\.law\.test\.\w+) \|/g)].map(
      (m) => m[1]
    );
    const ghosts = listed.filter((f) => !lawFiles.includes(f));
    expect(
      ghosts,
      `docs/LAWS.md lists law files that no longer exist: ${ghosts.join(', ')}. ` +
        `If the law was deliberately retired, delete its row in the same PR that ` +
        `deleted the test; if it was not, the deletion is a regression — restore it.`
    ).toEqual([]);
  });

  it('the hamburger ruling stays settled: the counter-law must not return', () => {
    // Dan's ruling, recorded 2026-09-01: "em bars" means em dashes, not menu
    // artwork. The banned counter-law took the menu off every page twice.
    expect(lawFiles.some((f) => /noThreeBarArtwork/i.test(f))).toBe(false);
    expect(registry).toContain('Resolved conflicts');
  });
});
