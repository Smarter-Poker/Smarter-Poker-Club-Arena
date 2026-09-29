/**
 * An app bundle that cannot reach its backend is refused at build time.
 *
 * 2026-09-29, first on-device walkthrough: a native build made from a checkout
 * with no .env booted to "Loading Failed" (`supabaseUrl is required`), and
 * `npm run build:native` had reported success. That bundle is also exactly
 * what the OTA job would push to every installed copy of the app.
 */
import { spawnSync } from 'node:child_process';
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

  it('vite itself refuses a native build with no backend, before building anything', () => {
    // Explicitly empty values outrank any .env on the machine, exactly as
    // they do for Vite, so this cannot start a real build.
    const run = spawnSync(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--logLevel', 'error'],
      {
        env: {
          ...process.env,
          VITE_NATIVE: '1',
          CA_DIST: 'dist-native-guard-test',
          CA_PUBLIC_BASE: '/',
          VITE_SUPABASE_URL: '',
          VITE_SUPABASE_ANON_KEY: '',
        },
        encoding: 'utf8',
        timeout: 60_000,
      }
    );
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}${run.stderr}`).toMatch(
      /Refusing to build an app bundle that cannot reach its backend/
    );
  }, 70_000);
});
