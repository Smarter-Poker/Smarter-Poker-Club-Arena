/**
 * LAW: TRUST IS RENEWED, AND BOUNDED (Realtime Phase 5, 2026-09-06)
 *
 * A socket was authenticated ONCE, at the upgrade, and then trusted for as
 * long as it stayed open. That is the 2026-09-03 outage seen from the other
 * side: the fix that day stopped a revoked session OPENING a socket and said
 * nothing about the sockets already open. With a seven-day access token and a
 * tab left open, a player who signed out - or was signed out by an admin, or
 * had their session revoked - keeps playing at a real table with real chips
 * until something else happens to break the connection.
 *
 * And nothing bounded how many sockets one account could hold at once.
 *
 * PINS
 *   1. Every live socket is re-checked on a period, from the heartbeat sweep -
 *      the one place every connection is already walked on a timer.
 *   2. ONLY a definitive rejection closes it. `unavailable` - GoTrue down, a
 *      5xx, a timeout - is never a refusal. Inverting that would sign every
 *      player out the moment auth had a bad minute, which is a worse outage
 *      than the one this prevents.
 *   3. The work is staggered per socket and bounded per sweep, so the
 *      mechanism protecting the platform cannot become a thundering herd
 *      against auth on a five-minute cycle.
 *   4. The slot is claimed BEFORE the await, so a slow GoTrue cannot make one
 *      socket re-checked on every sweep until it answers.
 *   5. The cap refuses the ARRIVING socket, never evicts an existing one: the
 *      old socket may be carrying a hand, and evicting would hand a client
 *      stuck in a connect loop a way to knock its own player off the felt.
 *   6. Both refusals are numbers on the always-on exposition. A refusal nobody
 *      can see is how twenty-two hours went by.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  recordWsReauthClose,
  recordWsSocketCapRefusal,
  wsTrustLimitPrometheusLines,
  _resetWsAuthRefusalsForTests,
} from './wsHelpers.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const ROOT = join(__dirname, '..', '..', '..');
const SERVER = readFileSync(
  join(ROOT, 'server', 'src', 'transport', 'EngineWebSocketServer.ts'),
  'utf8'
);
const GAME_SERVER = readFileSync(join(ROOT, 'server', 'src', 'GameServer.ts'), 'utf8');

describe('LAW 1/3/4 - re-auth runs on a timer, staggered and bounded', () => {
  it('the heartbeat sweep drives it, and drives it first', () => {
    const sweep = sliceMethod(SERVER, 'private heartbeatSweep(): void {');
    expect(sweep).toContain('this.reauthSweep(now)');
    const code = blankNonCode(sweep);
    // Before the ping loop: a socket whose session died is closed on this
    // sweep rather than pinged first and closed on the next one.
    expect(code.indexOf('this.reauthSweep(now)')).toBeLessThan(
      code.indexOf('for (const [ws, conn]')
    );
  });

  it('each socket has its own due time, spread across the period', () => {
    const fn = sliceMethod(SERVER, 'function staggeredReauthAt(): number {');
    expect(fn).toContain('Math.random() * REAUTH_INTERVAL_MS');
    // Both upgrade paths stagger; a path that did not would come due in a
    // block, which is the herd this exists to avoid.
    expect((SERVER.match(/nextReauthAt: staggeredReauthAt\(\)/g) ?? []).length).toBe(2);
  });

  it('no more than a fixed number are re-checked per sweep', () => {
    const fn = sliceMethod(SERVER, 'private reauthSweep(now: number): void {');
    expect(fn).toContain('if (checked >= REAUTH_MAX_PER_SWEEP) break');
  });

  it('the next slot is claimed BEFORE the await', () => {
    const fn = blankNonCode(sliceMethod(SERVER, 'private reauthSweep(now: number): void {'));
    const claim = fn.indexOf('conn.nextReauthAt = now + REAUTH_INTERVAL_MS');
    const ask = fn.indexOf('this.verifyToken(conn.token)');
    expect(claim).toBeGreaterThan(0);
    expect(claim, 'a slow GoTrue would re-queue the same socket every sweep').toBeLessThan(ask);
  });

  it('the socket keeps the token it opened with, on both paths', () => {
    expect(SERVER).toMatch(/token: string;/);
    expect(SERVER).toContain('this.onUpgraded(ws, req, auth.userId, tableId, clientIp, token)');
    expect(SERVER).toContain('this.onUpgradedMux(ws, userId, muxClientIp, muxToken)');
  });
});

describe('LAW 2 - only a definitive no closes a live socket', () => {
  const fn = sliceMethod(SERVER, 'private reauthSweep(now: number): void {');

  it("an 'unavailable' verdict is left alone", () => {
    expect(fn).toContain("if (denial.denied !== 'invalid') return");
  });

  it('a definitive rejection closes 4401 with the same reason the upgrade uses', () => {
    expect(fn).toContain('CLOSE_AUTH_FAILED');
    expect(fn).toContain('authRejectionReason(denial.code)');
  });

  it('a socket that vanished while we asked is not touched', () => {
    expect(fn).toContain('if (!this.connections.has(ws)) return');
  });

  it('and a thrown verifier never closes anything', () => {
    expect(fn).toMatch(/\.catch\(\(\) => \{[\s\S]*?\}\)/);
    const catchBlock = fn.slice(fn.indexOf('.catch('));
    expect(catchBlock).not.toContain('ws.close');
  });
});

describe('LAW 5 - the cap refuses the new socket, never the old one', () => {
  const fn = sliceMethod(SERVER, 'private refuseIfOverSocketCap(ws: WebSocket, userId: string)');

  it('closes the ARRIVING socket', () => {
    expect(fn).toContain('ws.close(CLOSE_RATE_LIMITED');
    // Nothing in here reaches for another connection to close.
    expect(fn).not.toContain('this.connections.delete');
    expect(fn).not.toContain('oldest');
  });

  it('uses 4429, which the client already backs off on', () => {
    expect(fn).toContain('CLOSE_RATE_LIMITED');
    expect(fn).toContain('too_many_sockets:');
  });

  it('runs before the connection is registered, on both paths', () => {
    for (const path of ['private onUpgraded(', 'private onUpgradedMux(']) {
      const body = blankNonCode(sliceMethod(SERVER, path));
      const guard = body.indexOf('this.refuseIfOverSocketCap(ws, userId)');
      const register = body.indexOf('this.connections.set(ws, conn)');
      expect(guard, `${path} does not check the cap`).toBeGreaterThan(-1);
      expect(guard, `${path} registers the socket before checking`).toBeLessThan(register);
    }
  });

  it('the cap is generous enough that normal play never meets it', () => {
    const cap = Number(SERVER.match(/MAX_SOCKETS_PER_USER = (\d+)/)![1]);
    // One tab is one socket however many tables it carries (the mux), so a
    // player on a laptop and a phone is two. Anything under about six would
    // start catching real people.
    expect(cap).toBeGreaterThanOrEqual(8);
  });
});

describe('LAW 6 - both refusals are numbers', () => {
  it('they count, and they are exposed at zero from the first scrape', () => {
    _resetWsAuthRefusalsForTests();
    let lines = wsTrustLimitPrometheusLines().join('\n');
    expect(lines).toContain('poker_ws_reauth_closed_total 0');
    expect(lines).toContain('poker_ws_socket_cap_refused_total 0');

    recordWsReauthClose();
    recordWsSocketCapRefusal();
    recordWsSocketCapRefusal();
    lines = wsTrustLimitPrometheusLines().join('\n');
    expect(lines).toContain('poker_ws_reauth_closed_total 1');
    expect(lines).toContain('poker_ws_socket_cap_refused_total 2');
    _resetWsAuthRefusalsForTests();
  });

  it('rendered on the always-on exposition, beside the other refusals', () => {
    expect(GAME_SERVER).toContain('...wsTrustLimitPrometheusLines(),');
  });

  it('the re-auth close is counted as an auth refusal too, on the right path', () => {
    const fn = sliceMethod(SERVER, 'private reauthSweep(now: number): void {');
    expect(fn).toContain("recordWsAuthRefusal(conn.isMux ? 'multi' : 'table', 'invalid')");
    expect(fn).toContain('recordWsReauthClose()');
  });
});
