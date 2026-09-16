/**
 * LAW: the tree that ships is typechecked, and nothing typechecks it three times.
 * ═══════════════════════════════════════════════════════════════════════════
 * Added 2026-09-04 with the push-to-live speed work.
 *
 * `tsc -b` was running in all three builds of every merge - ci.yml's
 * `Production Build` (46.7s), ci.yml's `CSS Beat E2E` (47.8s, and that job IS
 * the critical path) and publish-club-arena.yml (10.2s) - to answer one
 * question that the required `TypeScript Check` job had already answered on
 * the same commit.
 *
 * On THIS repo it also emits nothing. All three tsconfigs set
 * `"noEmit": true`, none declares `composite` or `references`, and
 * vite.config.ts loads no dts or checker plugin, so `tsc -b` writes no file
 * that `vite build` reads. Two dists built with and without it hash
 * identically. It is a typecheck wearing a build's clothes.
 *
 * So the split: ci.yml's two builds run `build:ci`, the publisher runs the
 * full `npm run build`. THE ASYMMETRY IS THE POINT, and this law pins both
 * halves of it, because either half alone is a bug:
 *
 *   - drop `tsc -b` from the publisher too and the tree that reaches players
 *     ships without ever being typechecked on the commit that ships it;
 *   - put it back in the CI builds and 94 seconds returns to the critical
 *     path to re-derive a result the pipeline already has.
 *
 * The structural facts are pinned as well, because they are the whole
 * justification. If someone adds `composite: true`, `references`, or a dts
 * plugin, `tsc -b` starts EMITTING and `build:ci` silently stops producing
 * the same bundle. That has to fail here rather than in production.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

/** tsconfigs carry comments and trailing commas; this is enough to read them. */
function readTsconfig(name: string): Record<string, unknown> {
  const stripped = read(name)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped);
}

describe('the build typechecks where it ships', () => {
  it('build is build:ci with a typecheck in front, so the two cannot drift', () => {
    expect(pkg.scripts.build).toBe('tsc -b && npm run build:ci');
  });

  it('build:ci runs no typechecker of its own', () => {
    expect(pkg.scripts['build:ci']).toBeTruthy();
    expect(pkg.scripts['build:ci']).not.toMatch(/\btsc\b/);
    // It is still a whole build - these are the steps that make the bundle.
    expect(pkg.scripts['build:ci']).toContain('vite build');
    expect(pkg.scripts['build:ci']).toContain('optimize-dist-media');
    expect(pkg.scripts['build:ci']).toContain('stamp-build-provenance');
  });

  it('the publisher builds the shipping tree WITH the typecheck', () => {
    const publisher = read('.github/workflows/publish-club-arena.yml');
    expect(publisher).toMatch(/run:\s*npm run build\s*$/m);
    expect(publisher).not.toMatch(/run:\s*npm run build:ci/);
  });

  it("CI's two throwaway builds use build:ci", () => {
    const ci = read('.github/workflows/ci.yml');
    const plain = ci.match(/run:\s*npm run build\s*$/gm) ?? [];
    const ciBuilds = ci.match(/run:\s*npm run build:ci\s*$/gm) ?? [];
    expect(ciBuilds).toHaveLength(2);
    expect(plain).toHaveLength(0);
  });

  it('TypeScript compilation still runs on every pull request and no diff filter can skip it', () => {
    const ci = read('.github/workflows/ci.yml');
    const job = parse(ci).jobs.typecheck_compile;
    expect(job.name).toBe('TypeScript compilation and repository checks');
    expect(job.needs).toBe('changes');
    // Classification failure still compiles; only workflow cancellation stops it.
    expect(job.if).toBe("${{ !cancelled() && github.event_name == 'pull_request' }}");
    const step = job.steps.find(
      (step: { name?: string }) => step.name === 'TypeScript Check'
    );
    expect(step.if).toBeUndefined();
    expect(step.run.trim().split('\n')).toEqual([
      'npx tsc --noEmit',
      'npx tsc -p tsconfig.node.json --noEmit',
    ]);
    // Only the journal step may use classification; never the compiler above.
    const classifiedSteps = job.steps.filter((step: { if?: string }) =>
      /needs\.changes/.test(step.if ?? '')
    );
    expect(classifiedSteps.map((step: { name: string }) => step.name)).toEqual([
      'Chip journal transactions survive failures and replays',
    ]);
    expect(classifiedSteps[0].if).toBe(
      "needs.changes.result != 'success' || needs.changes.outputs.server != 'false'"
    );
  });

  it('tsc -b emits nothing on this repo, which is why dropping it changes no byte', () => {
    for (const name of ['tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json']) {
      const cfg = readTsconfig(name);
      const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
      expect(opts.noEmit, `${name} must stay noEmit`).toBe(true);
      expect(opts.composite, `${name} must not become a composite project`).toBeUndefined();
      expect(opts.declaration, `${name} must not emit declarations`).toBeUndefined();
      expect(cfg.references, `${name} must declare no project references`).toBeUndefined();
    }
    const vite = read('vite.config.ts');
    for (const emitter of ['vite-plugin-dts', 'vite-plugin-checker', '@rollup/plugin-typescript']) {
      expect(vite, `${emitter} would make tsc part of the bundle`).not.toContain(emitter);
    }
  });
});
