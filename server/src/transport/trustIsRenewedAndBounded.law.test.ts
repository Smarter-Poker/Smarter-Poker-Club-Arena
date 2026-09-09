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
 *   7. EVERY socket, not two of the three. Phase 5 shipped this for the table
 *      and mux sockets and skipped `/ws/channel` - the same gap Phase 4 wrote
 *      a warning about, made one phase later, on the socket that carries
 *      FINANCIAL_UPDATE. The mechanism lives in wsHelpers now and each server
 *      hands it its own connection map, so there is one implementation and no
 *      way for two to drift.
 */
import { describe, it, expect, vi } from 'vitest';
import { runReauthSweep, socketsHeldBy, staggeredReauthAt } from './wsHelpers.js';
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
const CHANNEL = readFileSync(
  join(ROOT, 'server', 'src', 'transport', 'ChannelWebSocketServer.ts'),
  'utf8'
);
const HELPERS = readFileSync(join(ROOT, 'server', 'src', 'transport', 'wsHelpers.ts'), 'utf8');
/** The one implementation both servers call. */
const SWEEP = sliceMethod(
  HELPERS,
  'export function runReauthSweep<W, C extends ReauthableConnection>('
);
const CAP = sliceMethod(HELPERS, 'export function socketsHeldBy<W, C extends { userId: string }>(');

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
    const fn = sliceMethod(
      HELPERS,
      'export function staggeredReauthAt(intervalMs: number): number {'
    );
    expect(fn).toContain('Math.random() * intervalMs');
    // All THREE upgrade paths stagger - two table, one channel. A path that did
    // not would come due in a block, which is the herd this exists to avoid.
    const staggered =
      (SERVER.match(/nextReauthAt: staggeredReauthAt\(/g) ?? []).length +
      (CHANNEL.match(/nextReauthAt: staggeredReauthAt\(/g) ?? []).length;
    expect(staggered).toBe(3);
  });

  it('no more than a fixed number are re-checked per sweep', () => {
    expect(SWEEP).toContain('if (checked >= opts.maxPerSweep) break');
  });

  it('the next slot is claimed BEFORE the await', () => {
    const fn = blankNonCode(SWEEP);
    const claim = fn.indexOf('conn.nextReauthAt = opts.now + opts.intervalMs');
    const ask =
      fn.indexOf('opts\n      .verify(conn.token)') >= 0
        ? fn.indexOf('.verify(conn.token)')
        : fn.indexOf('.verify(conn.token)');
    expect(claim).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(0);
    expect(claim, 'a slow GoTrue would re-queue the same socket every sweep').toBeLessThan(ask);
  });

  it('the socket keeps the token it opened with, on both paths', () => {
    expect(SERVER).toMatch(/token: string;/);
    expect(SERVER).toContain(
      'this.onUpgraded(ws, req, auth.userId, tableId, clientIp, token, viewerAccess)'
    );
    expect(SERVER).toContain('this.onUpgradedMux(ws, userId, muxClientIp, muxToken)');
  });
});

describe('LAW 2 - only a definitive no closes a live socket', () => {
  it("an 'unavailable' verdict is left alone", () => {
    expect(SWEEP).toContain("if (denial.denied !== 'invalid') return");
  });

  it('a definitive rejection closes with the reason the upgrade uses', () => {
    expect(SWEEP).toContain('authRejectionReason(denial.code)');
    // Each server passes its own 4401 constant in; both are 4401.
    expect(SERVER).toContain('closeCode: CLOSE_AUTH_FAILED');
    expect(CHANNEL).toContain('closeCode: CLOSE_AUTH_FAILED');
  });

  it('a socket that vanished while we asked is not touched', () => {
    expect(SWEEP).toContain('if (!opts.connections.has(ws)) return');
  });

  it('and a thrown verifier never closes anything', () => {
    const catchBlock = SWEEP.slice(SWEEP.indexOf('.catch('));
    expect(catchBlock).not.toContain('close(');
  });
});

describe('LAW 5 - the cap refuses the new socket, never the old one', () => {
  const fn = sliceMethod(SERVER, 'private refuseIfOverSocketCap(ws: WebSocket, userId: string)');

  it('counts through the shared counter, which only counts', () => {
    expect(fn).toContain('socketsHeldBy(this.connections, userId)');
    // It reads; it must never reach for a socket to close.
    expect(CAP).not.toContain('close(');
    expect(CAP).not.toContain('delete(');
  });

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
    expect(SWEEP).toContain("recordWsAuthRefusal(opts.path(conn), 'invalid')");
    expect(SWEEP).toContain('recordWsReauthClose()');
    // And each server labels its own sockets.
    expect(SERVER).toContain("path: (conn) => (conn.isMux ? 'multi' : 'table')");
    expect(CHANNEL).toContain("path: () => 'channel' as const");
  });
});

/**
 * LAW 7 - EVERY SOCKET, NOT TWO OF THE THREE (audit, 2026-09-06).
 *
 * Phase 4 wrote the warning: "a version on two of the three sockets is worse
 * than none". Phase 5 then shipped re-auth and the cap for the table and mux
 * sockets and skipped `/ws/channel` - which carries club presence, the lobby,
 * hand replay and FINANCIAL_UPDATE, so a revoked session went on receiving a
 * player's wallet balance and ledger entries indefinitely.
 */
describe('LAW 7 - the channel socket is covered too', () => {
  it('it re-checks, through the same shared sweep', () => {
    expect(CHANNEL).toContain('runReauthSweep({');
    const sweep = sliceMethod(CHANNEL, 'private heartbeatSweep(): void {');
    const code = blankNonCode(sweep);
    expect(code.indexOf('runReauthSweep({')).toBeLessThan(code.indexOf('for (const [ws, conn]'));
  });

  it('it caps, through the same shared counter, refusing the arriving socket', () => {
    const fn = sliceMethod(CHANNEL, 'private onUpgraded(ws: WebSocket, userId: string, token = ');
    expect(fn).toContain('socketsHeldBy(this.connections, userId) >= MAX_SOCKETS_PER_USER');
    expect(fn).toContain('CLOSE_RATE_LIMITED');
    expect(fn).toContain('recordWsSocketCapRefusal()');
    // Refused BEFORE it is registered, like the other two.
    const code = blankNonCode(fn);
    expect(code.indexOf('socketsHeldBy')).toBeLessThan(
      code.indexOf('this.connections.set(ws, conn)')
    );
  });

  it('it keeps the token it opened with', () => {
    expect(CHANNEL).toContain('this.onUpgraded(ws, userId, token)');
    expect(CHANNEL).toMatch(/token: string;/);
  });

  it('all three servers share ONE set of numbers', () => {
    // The channel server imports them rather than declaring its own, or the
    // three sockets would drift apart the first time one was tuned.
    expect(CHANNEL).toMatch(
      /REAUTH_INTERVAL_MS,\s*\n\s*REAUTH_MAX_PER_SWEEP,\s*\n\s*MAX_SOCKETS_PER_USER,/
    );
    expect(CHANNEL).not.toMatch(/const (REAUTH_INTERVAL_MS|MAX_SOCKETS_PER_USER) =/);
  });
});

/**
 * LAW 8 - AND THE SHARED MECHANISM IS EXERCISED, NOT ONLY READ (audit, 2026-09-06).
 *
 * Every pin above reads source text, which is the only way to state "the slot
 * is claimed before the await" or "this file imports the shared numbers". But
 * a law that only reads text cannot see a body that still SAYS the right words
 * and does the wrong thing. Found in this audit's own mutation run: replacing
 * `if (c.userId === userId) held++` with `held++` - a cap that refuses every
 * player once ANY four sockets exist - left all twenty-one pins green.
 *
 * So the shared helpers are also RUN here.
 */
describe('LAW 8 - the shared helpers behave', () => {
  type Conn = { token: string; nextReauthAt: number; userId: string };
  const conn = (userId: string, token = 't', nextReauthAt = 0): Conn => ({
    token,
    nextReauthAt,
    userId,
  });

  it('socketsHeldBy counts ONE account, not the room', () => {
    const m = new Map<object, Conn>([
      [{}, conn('a')],
      [{}, conn('a')],
      [{}, conn('b')],
      [{}, conn('c')],
    ]);
    expect(socketsHeldBy(m, 'a')).toBe(2);
    expect(socketsHeldBy(m, 'b')).toBe(1);
    expect(socketsHeldBy(m, 'zzz')).toBe(0);
  });

  it('staggeredReauthAt lands inside the period, never in a block', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const t = staggeredReauthAt(300_000);
      expect(t).toBeGreaterThanOrEqual(Date.now());
      expect(t).toBeLessThanOrEqual(Date.now() + 300_000);
      seen.add(t);
    }
    expect(seen.size, 'every socket came due at the same instant').toBeGreaterThan(50);
  });

  const sweep = (
    connections: Map<object, Conn>,
    verify: (token: string) => Promise<unknown>,
    close: (ws: object, code: number, reason: string) => void,
    now = 1_000_000
  ) =>
    runReauthSweep({
      now,
      connections,
      path: () => 'channel' as const,
      verify: verify as never,
      close,
      intervalMs: 300_000,
      maxPerSweep: 2,
      closeCode: 4401,
    });

  it('re-checks no more than the cap, and only what is due', async () => {
    const asked: string[] = [];
    const m = new Map<object, Conn>([
      // The not-due socket is FIRST: a sweep that ignored the due time would
      // spend one of its two slots on it, and the ones that are actually due
      // would wait another period.
      [{}, conn('d', 'four', 2_000_000)], // not due
      [{}, conn('a', 'one')],
      [{}, conn('b', 'two')],
      [{}, conn('c', 'three')],
    ]);
    sweep(
      m,
      async (t) => {
        asked.push(t);
        return { userId: 'ok' };
      },
      () => {}
    );
    await Promise.resolve();
    expect(asked).toEqual(['one', 'two']);
  });

  it('claims the next slot before it asks, so a slow verifier is not re-queued', () => {
    const c = conn('a');
    const m = new Map<object, Conn>([[{}, c]]);
    let resolve!: (v: unknown) => void;
    sweep(
      m,
      () => new Promise((r) => (resolve = r)),
      () => {}
    );
    expect(c.nextReauthAt, 'still due while the answer is outstanding').toBe(1_300_000);
    resolve({ userId: 'ok' });
  });

  it('closes 4401 on a definitive rejection - and nothing else does', async () => {
    const closed: Array<[number, string]> = [];
    const ws = {};
    const m = new Map<object, Conn>([[ws, conn('a')]]);
    sweep(
      m,
      async () => ({ denied: 'invalid', code: 'session_not_found' }),
      (_w, code, reason) => closed.push([code, reason])
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toEqual([[4401, 'auth:session_not_found']]);
  });

  it.each([
    ['a good token', { userId: 'u1' }],
    ['an auth outage', { denied: 'unavailable', code: 'upstream_5xx' }],
  ])('leaves the socket alone on %s', async (_label, verdict) => {
    const closed: number[] = [];
    const m = new Map<object, Conn>([[{}, conn('a')]]);
    sweep(
      m,
      async () => verdict,
      (_w, code) => closed.push(code)
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toEqual([]);
  });

  it('a socket that closed while we asked is not touched', async () => {
    const closed: number[] = [];
    const ws = {};
    const m = new Map<object, Conn>([[ws, conn('a')]]);
    sweep(
      m,
      async () => {
        m.delete(ws);
        return { denied: 'invalid', code: 'revoked' };
      },
      (_w, code) => closed.push(code)
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toEqual([]);
  });

  it('a verifier that throws never closes anything, and never rejects unhandled', async () => {
    const closed: number[] = [];
    const unhandled = vi.fn();
    process.once('unhandledRejection', unhandled);
    const m = new Map<object, Conn>([[{}, conn('a')]]);
    sweep(
      m,
      async () => {
        throw new Error('GoTrue is down');
      },
      (_w, code) => closed.push(code)
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(closed).toEqual([]);
    expect(unhandled).not.toHaveBeenCalled();
    process.off('unhandledRejection', unhandled);
  });
});
