/**
 * SENTRY NEVER COMES BACK (2026-09-27)
 *
 * Dan closed and deleted the Sentry account on 2026-09-27 and ordered it
 * removed from the engine, the app, the repository, the database and the
 * hosts with nothing left. The SDKs left the code on 2026-09-15/16 (#4718,
 * 397fe26e58); the last database objects left in
 * 20260927212653_the_database_keeps_nothing_of_sentry.sql.
 *
 * This law keeps it that way: no package manifest or lockfile in the
 * repository may declare or resolve an error-reporting SDK from the Sentry
 * scope, and no source file may import or require one.
 *
 * docs/changelog/2026-09-27-sentry-is-gone.md
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
// Spelled in two halves so this file does not match its own rule.
const SCOPE = '@' + 'sentry';
const FILES = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 512 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean);
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'overrides',
  'resolutions',
];

describe('Sentry never comes back', () => {
  it('no package.json declares a Sentry package', () => {
    const manifests = FILES.filter((f) => /(^|\/)package\.json$/.test(f));
    expect(manifests.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of manifests) {
      const pkg = JSON.parse(read(f)) as Record<string, unknown>;
      for (const field of DEPENDENCY_FIELDS) {
        const deps = pkg[field];
        const names = Array.isArray(deps)
          ? (deps as string[])
          : Object.keys((deps as Record<string, unknown>) ?? {});
        for (const name of names) {
          if (name.toLowerCase().startsWith(SCOPE + '/') || /(^|[^a-z])sentry/i.test(name)) {
            offenders.push(`${f} ${field}: ${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no lockfile resolves a Sentry package', () => {
    const locks = FILES.filter((f) =>
      /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f)
    );
    expect(locks.length).toBeGreaterThan(0);
    expect(
      locks.filter((f) =>
        read(f)
          .toLowerCase()
          .includes(SCOPE + '/')
      )
    ).toEqual([]);
  });

  it('no source file imports or requires a Sentry package', () => {
    const sources = FILES.filter(
      (f) => /\.(c|m)?(j|t)sx?$/.test(f) && !f.startsWith('supabase/migrations/')
    );
    expect(sources.length).toBeGreaterThan(100);
    const pattern = new RegExp(
      String.raw`(from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"\x60]` + SCOPE + '/',
      'i'
    );
    expect(sources.filter((f) => pattern.test(read(f)))).toEqual([]);
  });

  it('no workflow, env template or Docker file configures a Sentry key', () => {
    const configs = FILES.filter(
      (f) =>
        f.startsWith('.github/') ||
        /(^|\/)(\.env[^/]*|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|vercel\.json)$/.test(f)
    );
    expect(configs.filter((f) => /SENTRY_[A-Z]/.test(read(f)))).toEqual([]);
  });
});
