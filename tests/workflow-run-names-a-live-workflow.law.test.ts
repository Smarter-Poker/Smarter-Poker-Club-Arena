/**
 * LAW: a `workflow_run` listener names a workflow that exists.
 *
 * `on: workflow_run: workflows: [...]` matches the OTHER workflow's `name:`,
 * not its filename. Rename or delete that workflow and the listener does not
 * fail - it simply never fires again, and nothing anywhere says so.
 *
 * That is what happened on 2026-09-02. #2676 deleted build-for-world-hub.yml
 * (name "Build for World Hub Sync") and repointed fifteen files by FILENAME.
 * The post-deploy E2E listener named it by `name:` and was missed.
 *
 * From 19:17 that day until this pin landed, neither fired on a publish. The
 * The E2E did not run at all even though production kept publishing.
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

  it('the post-deploy listener follows the publisher', () => {
    expect(listenedNames(read('post-deploy-e2e.yml'))).toEqual(['Publish Club Arena']);
  });

  it('production certification requires a publication event', () => {
    const workflow = read('post-deploy-e2e.yml');
    const triggers = workflow.split(/^jobs:/m)[0];
    expect(triggers).not.toMatch(/^  schedule:/m);
    expect(triggers).toMatch(/^  repository_dispatch:/m);
    expect(listenedNames(workflow)).toEqual(['Publish Club Arena']);
    expect(workflow).not.toContain('if [ "$EVENT_NAME" = schedule ]');
    expect(workflow).toContain('Unsupported production certification event');
  });

  it('the parser sees a listener naming a dead workflow (mutant check)', () => {
    const fake =
      "name: X\non:\n  workflow_run:\n    workflows: ['Build for World Hub Sync']\n    types: [completed]\njobs:\n  a:\n    runs-on: x\n";
    expect(listenedNames(fake)).toEqual(['Build for World Hub Sync']);
    expect(liveNames.has('Build for World Hub Sync')).toBe(false);
  });
});
