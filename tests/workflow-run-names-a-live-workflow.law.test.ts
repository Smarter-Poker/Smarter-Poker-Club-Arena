/**
 * LAW: a `workflow_run` listener names a workflow that exists.
 *
 * `on: workflow_run: workflows: [...]` matches the OTHER workflow's `name:`,
 * not its filename. Rename or delete that workflow and the listener does not
 * fail - it simply never fires again, and nothing anywhere says so.
 *
 * That is what happened on 2026-09-02. #2676 deleted build-for-world-hub.yml
 * (name "Build for World Hub Sync") and repointed fifteen files by FILENAME.
 * Two listeners named it by `name:` and were missed:
 *
 *   publish-watchdog.yml  - the dispatcher that runs starved scheduled work,
 *                           the production-vs-main check, the orphan sweep
 *   post-deploy-e2e.yml   - the production E2E after every publish
 *
 * From 19:17 that day until this pin landed, neither fired on a publish. The
 * watchdog could only run from GitHub's throttled scheduler (about one run in
 * ten delivered), and the E2E did not run at all. Production kept publishing
 * - the publisher itself was fine - with every net that watches it cut.
 *
 * So: every name in every `workflow_run.workflows` list must be the `name:`
 * of a workflow file in this tree. Renaming a workflow means renaming its
 * listeners in the same commit, or this goes red at the pull request.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve(__dirname, '../.github/workflows');
const files = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => readFileSync(resolve(DIR, f), 'utf8');

const nameOf = (text: string): string | null => {
  const m = /^name:\s*(.+?)\s*$/m.exec(text);
  if (!m) return null;
  return m[1].replace(/^(['"])(.*)\1$/, '$2');
};

/** Every quoted or bare entry of a `workflows:` list under `workflow_run:`. */
const listenedNames = (text: string): string[] => {
  const out: string[] = [];
  const re = /^\s*workflow_run:\s*\n([\s\S]*?)(?=^\s*[a-z_]+:\s*$|^\S)/gm;
  let block: RegExpExecArray | null;
  while ((block = re.exec(text))) {
    const w =
      /workflows:\s*\[([^\]]*)\]/.exec(block[1]) ??
      /workflows:\s*\n((?:\s*-\s*.+\n)+)/.exec(block[1]);
    if (!w) continue;
    for (const raw of w[1].split(/,|\n/)) {
      const v = raw
        .replace(/^\s*-\s*/, '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (v) out.push(v);
    }
  }
  return out;
};

describe('a workflow_run listener names a workflow that exists', () => {
  const liveNames = new Set(files.map((f) => nameOf(read(f))).filter((n): n is string => !!n));

  it('finds the workflows in this tree', () => {
    expect(liveNames.size).toBeGreaterThan(10);
    expect(liveNames.has('Publish Club Arena')).toBe(true);
  });

  for (const f of files) {
    const names = listenedNames(read(f));
    if (names.length === 0) continue;
    it(`${f} listens to workflows that exist: ${names.join(', ')}`, () => {
      for (const n of names) {
        expect(
          liveNames.has(n),
          `${f} listens for "${n}" but no workflow in .github/workflows carries that name:`
        ).toBe(true);
      }
    });
  }

  it('the two listeners that were missed in #2676 follow the publisher', () => {
    expect(listenedNames(read('publish-watchdog.yml'))).toEqual(['Publish Club Arena']);
    expect(listenedNames(read('post-deploy-e2e.yml'))).toEqual(['Publish Club Arena']);
  });

  it('the parser sees a listener naming a dead workflow (mutant check)', () => {
    const fake =
      "name: X\non:\n  workflow_run:\n    workflows: ['Build for World Hub Sync']\n    types: [completed]\njobs:\n  a:\n    runs-on: x\n";
    expect(listenedNames(fake)).toEqual(['Build for World Hub Sync']);
    expect(liveNames.has('Build for World Hub Sync')).toBe(false);
  });
});
