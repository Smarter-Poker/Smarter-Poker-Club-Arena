/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A DEAD SESSION IS NOT A SIGNED-IN ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production, 2026-09-03, Dan's own live tab:
 *
 *   access token   valid ES256 signature, exp in 6.9 DAYS
 *   session_id     64cba0cf-…  NOT present in auth.sessions
 *   refresh token  "Invalid Refresh Token: Refresh Token Not Found"
 *   REST /clubs    200 with real rows  -> the app looked signed in
 *   engine socket  /ws/multi -> 401 -> close 1006, every retry, forever
 *
 * PostgREST checks a JWT's signature and expiry. GoTrue also checks that the
 * session still exists. So a session dying under a live tab is invisible to
 * every read and fatal to every socket - the lobby keeps its data and loses
 * all its live updates, with nothing on screen to act on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  signOut: vi.fn().mockResolvedValue({ error: null }),
  reportError: vi.fn(),
}));
const { getUser, signOut, reportError } = h;

vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { getUser: h.getUser, signOut: h.signOut } },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: h.reportError }));

import {
  confirmSessionIsLive,
  isSessionGoneMessage,
  _resetSessionLivenessForTests,
  SESSION_DEAD_EVENT,
  LIVENESS_PROBE_MIN_INTERVAL_MS,
} from '../../src/services/sessionLiveness';

beforeEach(() => {
  _resetSessionLivenessForTests();
  getUser.mockReset();
  signOut.mockClear();
  reportError.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('isSessionGoneMessage - what GoTrue says when the session is gone', () => {
  it('recognises the exact production messages', () => {
    // Captured from the live project this afternoon.
    expect(isSessionGoneMessage('Session from session_id claim in JWT does not exist')).toBe(true);
    expect(isSessionGoneMessage('Invalid Refresh Token: Refresh Token Not Found')).toBe(true);
    expect(isSessionGoneMessage('Auth session missing!')).toBe(true);
    expect(isSessionGoneMessage('session_not_found')).toBe(true);
  });

  it('does NOT treat a network or server failure as a logout', () => {
    // Signing a player out mid-hand because a probe timed out is worse than
    // the bug this fixes.
    for (const m of [
      'Failed to fetch',
      'NetworkError when attempting to fetch resource',
      'request timed out',
      'Internal Server Error',
      'upstream connect error',
      'Too Many Requests',
      '',
      null,
      undefined,
    ]) {
      expect(isSessionGoneMessage(m as string), String(m)).toBe(false);
    }
  });

  it('does not treat a ban as a dead session', () => {
    expect(isSessionGoneMessage('User is banned from this club')).toBe(false);
  });
});

describe('confirmSessionIsLive', () => {
  it('a live session is left alone', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    expect(await confirmSessionIsLive('probe')).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a session GoTrue has disowned is signed out locally and announced', async () => {
    const seen: string[] = [];
    const onDead = (e: Event) => seen.push((e as CustomEvent).detail?.reason);
    window.addEventListener(SESSION_DEAD_EVENT, onDead);
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Session from session_id claim in JWT does not exist' },
    });

    expect(await confirmSessionIsLive('mux handshake refused')).toBe(false);
    expect(signOut).toHaveBeenCalledTimes(1);
    // LOCAL only — a global sign-out would revoke sessions this tab does not own.
    expect(signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(seen).toEqual(['mux handshake refused']);
    expect(reportError).toHaveBeenCalledTimes(1);
    window.removeEventListener(SESSION_DEAD_EVENT, onDead);
  });

  it('a network failure NEVER signs anybody out', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Failed to fetch' } });
    expect(await confirmSessionIsLive('probe')).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a thrown probe NEVER signs anybody out', async () => {
    getUser.mockRejectedValue(new Error('offline'));
    expect(await confirmSessionIsLive('probe')).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('no user and no error is not an answer', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await confirmSessionIsLive('probe')).toBe(true);
    expect(signOut).not.toHaveBeenCalled();
  });

  it('a reconnect storm asks GoTrue once, not once per socket', async () => {
    // The mux reconnects on a backoff and every facade fails with it; without
    // the throttle a dead session would turn into a probe storm.
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    await Promise.all([
      confirmSessionIsLive('a'),
      confirmSessionIsLive('b'),
      confirmSessionIsLive('c'),
    ]);
    await confirmSessionIsLive('d');
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('and asks again once the throttle window has passed', async () => {
    vi.useFakeTimers();
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });
    await confirmSessionIsLive('first');
    vi.setSystemTime(Date.now() + LIVENESS_PROBE_MIN_INTERVAL_MS + 1);
    await confirmSessionIsLive('second');
    expect(getUser).toHaveBeenCalledTimes(2);
  });

  it('announces once, however many sockets fail', async () => {
    let count = 0;
    const onDead = () => count++;
    window.addEventListener(SESSION_DEAD_EVENT, onDead);
    vi.useFakeTimers();
    getUser.mockResolvedValue({
      data: { user: null },
      error: { message: 'Invalid Refresh Token: Refresh Token Not Found' },
    });
    await confirmSessionIsLive('one');
    vi.setSystemTime(Date.now() + LIVENESS_PROBE_MIN_INTERVAL_MS + 1);
    await confirmSessionIsLive('two');
    expect(count).toBe(1);
    window.removeEventListener(SESSION_DEAD_EVENT, onDead);
  });

  it('uses getUser, never getSession', async () => {
    // getSession reads localStorage and would cheerfully return the corpse
    // this module exists to find.
    const src = readFileSync(join(process.cwd(), 'src/services/sessionLiveness.ts'), 'utf8');
    expect(src).toContain('supabase.auth.getUser(');
    // The comment explains why getSession is wrong here, so check for the CALL.
    expect(src).not.toContain('supabase.auth.getSession(');
    expect(src).not.toMatch(/\bawait\s+\w*\.?getSession\(/);
  });
});

describe('the mux asks the question', () => {
  const src = readFileSync(join(process.cwd(), 'src/services/EngineSocketMux.ts'), 'utf8');

  it('probes when a socket closes WITHOUT ever having opened', () => {
    expect(src).toContain("confirmSessionIsLive('mux handshake refused')");
    expect(src).toMatch(/if\s*\(!opened\)\s*void confirmSessionIsLive/);
  });

  it('does not probe when a socket that was OPEN merely drops', () => {
    // An established socket dropping is a network event, not an auth one.
    expect(src).toMatch(/let opened = false;/);
    expect(src).toMatch(/opened = true;/);
    const onclose = src.slice(src.indexOf('ws.onclose'));
    const probeAt = onclose.indexOf('confirmSessionIsLive');
    const guardAt = onclose.indexOf('if (!opened)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(probeAt);
  });
});
