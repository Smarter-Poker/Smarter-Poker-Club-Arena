/**
 * An app bundle that cannot reach its backend is refused at build time.
 *
 * 2026-09-29, first on-device walkthrough: a native build made from a checkout
 * with no .env booted to "Loading Failed" (`supabaseUrl is required`), and
 * `npm run build:native` had reported success. That bundle is also exactly
 * what the OTA job would push to every installed copy of the app.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertNativeBackend,
  nativeBackendProblems,
} from '../../scripts/native/require-native-backend.mjs';

const GOOD = {
  VITE_SUPABASE_URL: 'https://kuklfnapbkmacvwxktbh.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'sb_publishable_example',
};

describe('a native bundle needs its backend', () => {
  it('names every missing or malformed setting', () => {
    expect(nativeBackendProblems(GOOD)).toEqual([]);
    expect(nativeBackendProblems({})).toEqual([
      'VITE_SUPABASE_URL is empty',
      'VITE_SUPABASE_ANON_KEY is empty',
    ]);
    expect(nativeBackendProblems({ ...GOOD, VITE_SUPABASE_URL: '   ' })).toEqual([
      'VITE_SUPABASE_URL is empty',
    ]);
    expect(nativeBackendProblems({ ...GOOD, VITE_SUPABASE_URL: 'kuklfnapbkmacvwxktbh' })).toEqual([
      'VITE_SUPABASE_URL is not a URL',
    ]);
    expect(nativeBackendProblems({ ...GOOD, VITE_SUPABASE_URL: 'http://example.test' })).toEqual([
      'VITE_SUPABASE_URL is not https',
    ]);
    expect(() => assertNativeBackend(GOOD)).not.toThrow();
    expect(() => assertNativeBackend({})).toThrow(/cannot reach its backend/);
  });

  const guard = (env: Record<string, string>) =>
    spawnSync(process.execPath, ['scripts/native/require-native-backend.mjs'], {
      // Explicitly empty values outrank any .env on the machine, exactly as
      // they do for Vite, so this never depends on the workstation.
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 30_000,
    });

  it('the build:native script refuses before building anything when the backend is missing', () => {
    const run = guard({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/Refusing to build an app bundle that cannot reach its backend/);
    expect(run.stderr).toMatch(/VITE_SUPABASE_URL is empty; VITE_SUPABASE_ANON_KEY is empty/);
  }, 40_000);

  it('and lets a build with its backend through', () => {
    const run = guard(GOOD);
    expect(run.status, run.stderr).toBe(0);
  }, 40_000);

  it('runs FIRST in build:native, which every installable bundle goes through', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(
      pkg.scripts['build:native'].startsWith('node scripts/native/require-native-backend.mjs && ')
    ).toBe(true);
  });
});
