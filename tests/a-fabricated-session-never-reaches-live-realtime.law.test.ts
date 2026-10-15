/**
 * LAW: a browser spec that plants a fabricated session never lets it reach
 * live Supabase Realtime.
 *
 * tests/e2e/financial-decision-human-path.spec.ts seeds a made-up session
 * (HS256, no key id, signature 'test-signature', 24 hour expiry, subject
 * 11111111-2222-4333-8444-555555555555) and mocks REST and Auth. The Realtime
 * WebSocket was never mocked, so on a shared preview wired to production every
 * run joined production Realtime with that token and was refused
 * (JwtSignatureError). In October 2026 those refusals, plus the World Hub's
 * own fixture sessions, were the project's entire Realtime error log, and
 * Supabase support (ticket SU-505102) read them as a signer fault on the
 * project.
 *
 * tests/e2e/support/realtimeSessionGuard.ts refuses any join whose
 * access_token is not an asymmetric, key-identified JWT, before a server
 * socket opens. Real sessions and the publishable key pass through, so specs
 * that sign in for real still exercise live Realtime.
 *
 * Scope: tests/e2e and e2e-live, the suites that can point at production.
 * tests/stale-client routes every WebSocket to its own mock and runs against
 * example.supabase.co; tests/push-browser serves a harness with no Supabase
 * client. The World Hub carries the same law for its own e2e directory.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fabricatedTokenIn, isIssuedAccessToken } from './e2e/support/realtimeSessionGuard';

const ROOT = join(__dirname, '..');
const SUITES = ['tests/e2e', 'e2e-live'].map((dir) => join(ROOT, dir)).filter(existsSync);

function browserFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : browserFiles(full);
    return /\.ts$/.test(entry.name) ? [full] : [];
  });
}

// A file fabricates a session when it writes an access_token of its own into
// storage. A spec that signs in for real receives the token from Supabase
// Auth and stores the session object it was given.
function fabricatesSession(source: string): boolean {
  return /access_token\s*:/.test(source) && /localStorage\.setItem\(/.test(source);
}

describe('a fabricated session never reaches live Realtime', () => {
  it('every e2e file that fabricates a session installs the Realtime session guard', () => {
    const unguarded = SUITES.flatMap(browserFiles)
      .filter((file) => !file.endsWith('realtimeSessionGuard.ts'))
      .filter((file) => fabricatesSession(readFileSync(file, 'utf8')))
      .filter((file) => !/installRealtimeSessionGuard\(\s*context\s*\)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(unguarded).toEqual([]);
  });

  it('still recognises the spec this law was written for', () => {
    const source = readFileSync(join(ROOT, 'tests/e2e/financial-decision-human-path.spec.ts'), 'utf8');
    expect(fabricatesSession(source)).toBe(true);
  });

  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = (header: object) => `${b64(header)}.${b64({ sub: 'x' })}.c2lnbmF0dXJl`;

  it('accepts sessions Supabase Auth issues and the publishable key', () => {
    expect(isIssuedAccessToken(jwt({ alg: 'ES256', kid: 'f3c1', typ: 'JWT' }))).toBe(true);
    expect(isIssuedAccessToken('sb_publishable_example')).toBe(true);
  });

  it('refuses every fixture shape that reached production', () => {
    // this repo: HS256, no kid, literal signature
    expect(isIssuedAccessToken(`${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'x' })}.test-signature`)).toBe(false);
    // World Hub horses console: empty header
    expect(isIssuedAccessToken(`e30.${b64({ sub: 'x' })}.phase9`)).toBe(false);
    // World Hub video library and footer: not a JWT
    expect(isIssuedAccessToken('local-browser-fixture-only')).toBe(false);
    expect(isIssuedAccessToken(jwt({ alg: 'HS256', kid: 'legacy' }))).toBe(false);
    expect(isIssuedAccessToken(jwt({ alg: 'none', kid: 'x' }))).toBe(false);
  });

  it('reads the token out of a channel join and ignores messages that carry none', () => {
    const join = (token: string) =>
      JSON.stringify({ topic: 'realtime:private:x', event: 'phx_join', payload: { access_token: token }, ref: '1' });
    expect(fabricatedTokenIn(join('test-session'))).toBe('test-session');
    expect(fabricatedTokenIn(join(jwt({ alg: 'ES256', kid: 'f3c1' })))).toBeNull();
    expect(fabricatedTokenIn(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {} }))).toBeNull();
  });
});
