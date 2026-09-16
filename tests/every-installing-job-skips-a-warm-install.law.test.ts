/**
 * LAW: a job that restores node_modules does not then delete it.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04. `npm ci` REMOVES node_modules before installing - that is
 * its documented behaviour and the whole reason it is reproducible. So a job
 * that restores a node_modules cache and then runs `npm ci` unconditionally
 * has not made itself faster. It has made itself slower: it pays to download
 * and unpack a ~1GB tree, deletes it, and installs from scratch anyway.
 *
 * CSS Beat E2E did exactly that, and it is the critical path of the whole
 * pipeline. Its cache step even carried a comment explaining that
 * `node_modules/.vite` and `node_modules/.tmp/*.tsbuildinfo` "ride along" so
 * the Vite transform and `tsc -b` start warm - and the very next step deleted
 * both. The three sibling jobs had carried the `if:` guard since 2026-09-01;
 * this one was missed, silently, because a cache that does nothing looks
 * exactly like a cache that works.
 *
 * The cost is not theoretical. On 2026-09-04 the sibling typecheck job spent
 * **8.62 minutes** in a cold `npm ci` while twelve runners on one box
 * installed at once. Any job doing that unnecessarily is spending that twice:
 * once on the install, and again on the cold build caches it just destroyed.
 *
 * THE GENERAL FORM: a cache is only a cache if something USES what it
 * restored. This law makes the pairing structural - restore and guard, in
 * every job, or neither.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/publish-club-arena.yml'];

/**
 * Split a workflow into job blocks. Jobs are two-space keys; everything under
 * one until the next is that job's text.
 */
function jobs(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /\n {2}([a-z_][a-z0-9_-]*):\n/gi;
  let m: RegExpExecArray | null;
  const marks: Array<{ name: string; at: number }> = [];
  while ((m = re.exec(text))) marks.push({ name: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    out.push({
      name: marks[i].name,
      body: text.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : text.length),
    });
  }
  return out;
}

describe('every job that restores node_modules skips the install on a hit', () => {
  it('finds the jobs to check', () => {
    const found = WORKFLOWS.flatMap((w) => jobs(read(w))).filter(
      (j) => /path:\s*(?:server\/)?node_modules\s*$/m.test(j.body) && /npm ci/.test(j.body)
    );
    // If this ever hits zero the sweep below is asserting nothing at all -
    // the shape of guard this estate has shipped before (sixteen invariants
    // that printed "all passed" and ran none).
    expect(found.length, 'no job restores node_modules and installs').toBeGreaterThan(2);
  });

  it('none of them runs npm ci on a cache hit', () => {
    const offenders: string[] = [];
    for (const workflow of WORKFLOWS) {
      const text = read(workflow);
      for (const job of jobs(text)) {
        if (!/path:\s*(?:server\/)?node_modules\s*$/m.test(job.body)) continue;
        if (!/run:\s*npm ci/.test(job.body)) continue;

        // The restore step must be identifiable...
        const hasId =
          /uses:\s*actions\/cache@[^\n]*\n(?:[^\n]*\n)*?[^\n]*path:\s*(?:server\/)?node_modules/.test(
            job.body
          );
        // ...and the install must be gated on its result.
        const guarded =
          /if:\s*steps\.[a-z0-9_-]+\.outputs\.cache-hit != 'true'\s*\n\s*run:\s*npm ci/.test(
            job.body
          );
        if (!hasId || !guarded) {
          offenders.push(
            `${workflow} job "${job.name}" restores node_modules and then runs npm ci ` +
              'unconditionally. npm ci DELETES node_modules first, so the restore is ' +
              'pure cost - and it takes the warm .vite and .tsbuildinfo with it.'
          );
        }
      }
    }
    expect(offenders, offenders.join('\n  ')).toHaveLength(0);
  });

  it('the beats job in particular, because it is the critical path', () => {
    const ci = read('.github/workflows/ci.yml');
    // By job KEY, not by a string that also appears in another job's comments.
    const beats = jobs(ci).find((j) => j.name === 'css-beats-e2e-work');
    expect(beats, 'the CSS Beat E2E job disappeared').toBeTruthy();
    expect(beats!.body).toMatch(/id: nm-cache/);
    expect(beats!.body).toMatch(
      /if: steps\.nm-cache\.outputs\.cache-hit != 'true'\s*\n\s*run: npm ci --ignore-scripts/
    );
  });
});

describe('an installed dependency cache hit needs no npm archive transfer', () => {
  const installedJobs = WORKFLOWS.flatMap((workflow) =>
    jobs(read(workflow))
      .filter((job) => /path:\s*(?:server\/)?node_modules\s*$/m.test(job.body))
      .map((job) => ({ ...job, workflow }))
  );

  it('covers every existing installed-cache job in CI and the publisher', () => {
    expect(installedJobs.map(({ name }) => name).sort()).toEqual(
      [
        'typecheck_compile',
        'unit_shards',
        'server_shards',
        'build',
        'css-beats-e2e',
        'client-tests',
        'build-and-store',
        'publish-to-app',
      ].sort()
    );
  });

  for (const job of installedJobs) {
    it(`${job.workflow}: ${job.name} restores npm only when installation is needed`, () => {
      const steps = job.body.split(/^ {6}- /m).slice(1);
      const installed = steps.findIndex((step) =>
        /path:\s*(?:server\/)?node_modules\s*$/m.test(step)
      );
      const setup = steps.findIndex((step) => /uses:\s*actions\/setup-node@/.test(step));
      const install = steps.findIndex((step) => /^\s*run:\s*npm ci(?:\s|$)/m.test(step));
      expect(installed).toBeGreaterThanOrEqual(0);
      expect(setup).toBeGreaterThan(installed);
      expect(install).toBeGreaterThan(setup);
      expect(steps[installed]).toMatch(/^\s*id: nm-cache$/m);
      const input = steps[setup].match(/^\s*cache:\s*(.+)$/m)?.[1];
      expect(input).toBe("${{ steps.nm-cache.outputs.cache-hit != 'true' && 'npm' || '' }}");
      expect(steps[install]).toMatch(/^\s*if: steps\.nm-cache\.outputs\.cache-hit != 'true'$/m);

      // Evaluate the actual restricted predicate above. Empty/partial restores
      // still select npm and npm ci; only an exact hit skips npm restoration
      // and installation.
      const expression = input!
        .slice(3, -2)
        .replace('steps.nm-cache.outputs.cache-hit', 'cacheHit');
      const npmCache = new Function('cacheHit', `return (${expression});`) as (
        cacheHit: string | undefined
      ) => string;
      for (const [hit, expected] of [
        ['true', ''],
        ['false', 'npm'],
        ['', 'npm'],
        [undefined, 'npm'],
      ] as const) {
        expect(npmCache(hit)).toBe(expected);
      }
    });
  }
});
