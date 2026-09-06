/**
 * LAW: THE ENGINE SAYS WHICH PROTOCOL IT SPEAKS (Realtime Phase 4, 2026-09-05)
 *
 * Club Arena's origin keeps old assets on purpose (CLAUDE.md 1.1): `/assets/*`
 * is an ADDITIVE pool nothing deletes, so a player whose tab has been open
 * since yesterday is running yesterday's bundle against today's engine, right
 * now, mid-hand. That is a feature - it is what stops a deploy 404ing a
 * player's chunks - and it is exactly why the engine has to be able to say
 * "not that old".
 *
 * Until this phase it could not. Nothing on the wire said which protocol
 * either side spoke, so the only way to change a frame's shape was to hope no
 * stale tab was reading it, or to carry both shapes forever.
 *
 * The gate is a NO-OP today (`MIN_CLIENT_PROTOCOL` is 0, every client is
 * accepted, including the bundles that predate the parameter and send
 * nothing). It is installed now so that the day a frame changes there is
 * somewhere to put the number.
 *
 * PINS
 *   1. The version travels on the URL of BOTH sockets, from one builder. A
 *      version on only the multiplexed socket would refuse the stale bundles
 *      that happened to be muxed and silently serve the rest.
 *   2. A version the engine will not serve is refused with a CLOSE FRAME
 *      (4426), never a pre-handshake HTTP status - which reaches JavaScript
 *      as 1006 and means "try again", the one thing a stale bundle must not
 *      do. This is the 2026-09-03 lesson applied before it costs anything.
 *   3. Absent, malformed and negative all read as 0, never NaN. A comparison
 *      against NaN is false, which would let garbage through the one gate
 *      meant to catch it.
 *   4. The gate is open today, and closing it is a deliberate one-line change
 *      that reloads every tab below the new number.
 *   5. The client answers 4426 by fetching NEW BYTES - the shared hardReload,
 *      not a plain reload, which re-serves the same cached document.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MIN_CLIENT_PROTOCOL,
  CLOSE_UPGRADE_REQUIRED,
  clientProtocolVersion,
} from './EngineWebSocketServer.js';
import { blankNonCode, sliceMethod } from '../testHelpers/sourceWindow.js';

const ROOT = join(__dirname, '..', '..', '..');
const SERVER = readFileSync(
  join(ROOT, 'server', 'src', 'transport', 'EngineWebSocketServer.ts'),
  'utf8'
);
const MUX = readFileSync(join(ROOT, 'src', 'services', 'EngineSocketMux.ts'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'src', 'services', 'EngineStateClient.ts'), 'utf8');

describe('LAW 1 - one builder, both sockets', () => {
  it('the URL builder appends the version', () => {
    const fn = sliceMethod(MUX, 'export function engineSocketUrl(');
    expect(fn).toContain('v=${PROTOCOL_VERSION}');
    // Survives a path that already has a query rather than producing `?a=1?v=`.
    expect(fn).toContain("path.includes('?') ? '&' : '?'");
  });

  it('the multiplexed socket uses it', () => {
    expect(MUX).toContain("engineSocketUrl(this.baseUrl, '/ws/multi')");
  });

  it('the per-table socket uses it too', () => {
    expect(CLIENT).toContain(
      "engineSocketUrl(this.opts.baseUrl, '/ws/table/' + this.opts.tableId)"
    );
  });

  it('and so does the third socket, the channel one', () => {
    // Club presence, the lobby and financial updates rather than a hand - but
    // its frames can change shape too, and a version on two of the three
    // sockets is the same "worse than none" this builder exists to stop.
    expect(CLIENT).toContain("engineSocketUrl(this.opts.baseUrl, '/ws/channel')");
    const chan = readFileSync(
      join(ROOT, 'server', 'src', 'transport', 'ChannelWebSocketServer.ts'),
      'utf8'
    );
    expect(chan).toContain('clientProtocolVersion(url) < MIN_CLIENT_PROTOCOL');
    // Through the SHARED refusal, which is where the counter lives. It used to
    // inline its own close (audit, 2026-09-05).
    expect(chan).toContain('refuseProtocol(this.wss, req, socket, head');
    // Imported, never redefined: a second copy of the number is how two
    // sockets end up disagreeing about which bundles they serve.
    expect(chan).not.toMatch(/const (MIN_CLIENT_PROTOCOL|CLOSE_UPGRADE_REQUIRED) =/);
  });

  it('neither builds a socket URL by hand any more', () => {
    // A hand-built URL is a socket with no version on it, which is the whole
    // failure this law exists to prevent.
    /* Raw source, not blanked: the scheme rewrite is `replace(/^http/, 'ws')`
       and blankNonCode erases the 'ws' by design. */
    const rewrites = (s: string) => (s.match(/replace\(\/\^http\/, 'ws'\)/g) ?? []).length;
    // Exactly one in the mux - the builder itself - and none anywhere else.
    expect(rewrites(MUX), 'EngineSocketMux builds a ws:// URL outside engineSocketUrl').toBe(1);
    expect(rewrites(CLIENT), 'EngineStateClient builds a ws:// URL by hand').toBe(0);
    // And that one is inside the builder, not beside it.
    expect(sliceMethod(MUX, 'export function engineSocketUrl(')).toContain(
      "replace(/^http/, 'ws')"
    );
  });
});

describe('LAW 2 - refused with a close frame, not an HTTP status', () => {
  it('refuseProtocol completes the handshake and then closes 4426', () => {
    const fn = sliceMethod(SERVER, 'function refuseProtocol(');
    expect(fn).toContain('wss.handleUpgrade(');
    expect(fn).toContain('CLOSE_UPGRADE_REQUIRED');
    // Never the pre-handshake shape, which the browser reports as 1006.
    expect(fn).not.toContain('socket.write(');
    expect(fn).not.toContain('socket.destroy(');
  });

  it('the reason names both numbers, so a log needs no cross-reference', () => {
    const fn = sliceMethod(SERVER, 'function refuseProtocol(');
    expect(fn).toMatch(/upgrade_required:\$\{saw\}<\$\{MIN_CLIENT_PROTOCOL\}/);
  });

  it('the gate runs for both socket paths', () => {
    const gate = SERVER.slice(
      SERVER.indexOf('PROTOCOL GATE'),
      SERVER.indexOf('if (url.pathname === ')
    );
    expect(gate).toContain("'/ws/multi'");
    expect(gate).toContain("'/ws/table/'");
  });

  it('4426 is the same number on both sides', () => {
    expect(CLOSE_UPGRADE_REQUIRED).toBe(4426);
    expect(CLIENT).toContain('export const CLOSE_UPGRADE_REQUIRED = 4426;');
  });
});

/**
 * LAW 2b - A REFUSAL IS A NUMBER (audit, 2026-09-05).
 *
 * The auth counter next to this one exists because twenty-two hours of
 * refusals were not a number anywhere. The protocol gate shipped with exactly
 * that defect: it refused a socket and recorded nothing. On the day
 * `MIN_CLIENT_PROTOCOL` is raised, the wave of stale tabs being turned away is
 * the ONE thing worth watching - it tells you whether it is draining (tabs
 * fetching a new bundle, as designed) or flat (tabs reloading into the same
 * refusal, which would be a loop) - and it would have been invisible.
 */
describe('LAW 2b - a protocol refusal is counted and exposed', () => {
  const HELPERS = readFileSync(join(ROOT, 'server', 'src', 'transport', 'wsHelpers.ts'), 'utf8');
  const GAME_SERVER = readFileSync(join(ROOT, 'server', 'src', 'GameServer.ts'), 'utf8');

  it('the refusal records it, and there is one refusal to record it in', () => {
    const fn = sliceMethod(SERVER, 'export function refuseProtocol(');
    expect(fn).toContain('recordWsProtocolRefusal(path)');
    // Counted BEFORE the handshake completes, so a close that throws is still
    // counted - the number is about the decision, not about the delivery.
    expect(fn.indexOf('recordWsProtocolRefusal(path)')).toBeLessThan(
      fn.indexOf('wss.handleUpgrade(')
    );
  });

  it('every socket uses that one refusal rather than its own copy', () => {
    const chan = readFileSync(
      join(ROOT, 'server', 'src', 'transport', 'ChannelWebSocketServer.ts'),
      'utf8'
    );
    expect(chan).toContain('refuseProtocol(this.wss, req, socket, head');
    // The inlined copy is gone: no second place writes a 4426 close.
    expect(chan).not.toContain('CLOSE_UPGRADE_REQUIRED,');
    expect((SERVER.match(/ws\.close\(CLOSE_UPGRADE_REQUIRED/g) ?? []).length).toBe(1);
  });

  it('all three paths are labelled, so the wave can be told apart', () => {
    expect(SERVER).toContain("url.pathname === '/ws/multi' ? 'multi' : 'table'");
    const chan = readFileSync(
      join(ROOT, 'server', 'src', 'transport', 'ChannelWebSocketServer.ts'),
      'utf8'
    );
    expect(chan).toContain("'channel'");
  });

  it('it is exposed on the always-on metrics, at zero, from the first scrape', () => {
    expect(HELPERS).toContain('poker_ws_protocol_refused_total');
    const lines = sliceMethod(HELPERS, 'export function wsProtocolRefusalPrometheusLines()');
    // Every path is emitted, so a zero is visible rather than absent - an
    // absent series and a zero one mean opposite things on a dashboard.
    expect(lines).toContain("for (const path of ['table', 'multi', 'channel'] as const)");
    expect(lines).toContain('poker_ws_protocol_refused_total{path=');
    // Rendered beside the auth counter, on the exposition that is never gated.
    expect(GAME_SERVER).toContain('...wsProtocolRefusalPrometheusLines(),');
  });
});

describe('LAW 3 - the parser cannot be fooled', () => {
  const url = (q: string) => new URL(`http://x/ws/multi${q}`);

  it('reads a real version', () => {
    expect(clientProtocolVersion(url('?v=1'))).toBe(1);
    expect(clientProtocolVersion(url('?v=42'))).toBe(42);
  });

  it('treats absent as 0 - the version of every bundle that predates it', () => {
    expect(clientProtocolVersion(url(''))).toBe(0);
    expect(clientProtocolVersion(url('?other=1'))).toBe(0);
  });

  it('never returns NaN, whatever is sent', () => {
    for (const q of ['?v=', '?v=abc', '?v=-3', '?v=NaN', '?v=1e999', '?v=%20', '?v=0', '?v=null']) {
      const n = clientProtocolVersion(url(q));
      expect(Number.isNaN(n), `${q} produced NaN`).toBe(false);
      expect(Number.isInteger(n), `${q} produced a non-integer`).toBe(true);
      expect(n, `${q} produced a negative version`).toBeGreaterThanOrEqual(0);
    }
  });

  it('anything that is not a positive integer reads as 0', () => {
    for (const q of ['?v=', '?v=abc', '?v=-3', '?v=NaN', '?v=%20', '?v=0', '?v=null']) {
      expect(clientProtocolVersion(url(q)), `${q} should read as 0`).toBe(0);
    }
    /* `?v=1e999` is the one that is NOT garbage: parseInt stops at the `e` and
       reads 1, which is a real version this client could be sending. Recorded
       rather than asserted away - the gate's job is to be un-foolable, not to
       reject every odd-looking string. */
    expect(clientProtocolVersion(url('?v=1e999'))).toBe(1);
  });
});

describe('LAW 4 - open today, and closing it is deliberate', () => {
  it('accepts every client while the minimum is zero', () => {
    expect(MIN_CLIENT_PROTOCOL).toBe(0);
    // Which means the gate below cannot fire: 0 < 0 is false.
    expect(clientProtocolVersion(new URL('http://x/ws/multi'))).toBeGreaterThanOrEqual(
      MIN_CLIENT_PROTOCOL
    );
  });

  it('the client sends a version above zero, so raising the floor has an effect', () => {
    expect(MUX).toMatch(/export const PROTOCOL_VERSION = [1-9]\d*;/);
  });
});

describe('LAW 5 - the client answers 4426 with new bytes', () => {
  it('uses the shared hard reload, not location.reload()', () => {
    const fn = sliceMethod(CLIENT, 'function reloadForNewBundle(): Promise<void> {');
    /* The specifier is assembled rather than written out, and that is not
       cosmetic. This test file lives under server/src, where
       `TournamentFixes.guard` scans every .ts for a relative `import('...')`
       missing its .js extension - the guard that caught the two specifiers
       which left main unbootable. The string it is looking for is exactly the
       one this assertion is ABOUT, and the path is a browser specifier that
       Vite resolves, so it correctly has no extension. Assembling it asserts
       the same thing without handing that guard a false positive. */
    const lazyLoader = ['..', 'utils', 'lazyWithRetry'].join('/');
    expect(fn).toContain(`import('${lazyLoader}')`);
    expect(fn).toContain('m.hardReload()');
  });

  it('there is exactly one hardReload in the app', () => {
    const util = readFileSync(join(ROOT, 'src', 'utils', 'lazyWithRetry.ts'), 'utf8');
    expect(util).toContain('export async function hardReload()');
    // It purges what a plain reload would re-serve.
    expect(util).toContain('serviceWorker');
    expect(util).toContain('caches.delete');
    expect(util).toContain("searchParams.set('_cb'");
  });

  it('only one of them reloads, however many facades saw the close', () => {
    /* The multiplexed socket carries every table, so one 4426 closes four
       facades at once and each client answers it - four concurrent
       service-worker unregistrations and Cache Storage purges racing on a page
       that is leaving anyway (audit, 2026-09-05). */
    expect(CLIENT).toContain('let reloadingForNewBundle = false;');
    const fn = sliceMethod(CLIENT, 'function reloadForNewBundle(): Promise<void> {');
    expect(fn).toContain('if (reloadingForNewBundle) return Promise.resolve();');
    expect(fn).toContain('reloadingForNewBundle = true;');
  });

  it('and it stops the ladder rather than reconnecting into the same refusal', () => {
    const at = CLIENT.indexOf('if (e.code === CLOSE_UPGRADE_REQUIRED) {');
    expect(at, 'the 4426 branch is gone').toBeGreaterThan(-1);
    // Bounded by the branch that follows it, searched FORWARD from here -
    // `CLOSE_RATE_LIMITED` also appears in the constants at the top of the
    // file, and searching from zero produced an empty window that passed
    // every negative assertion in it.
    const block = CLIENT.slice(at, CLIENT.indexOf('CLOSE_RATE_LIMITED', at));
    expect(block).toContain('reloadForNewBundle()');
    expect(block).toContain('return;');
    expect(block).not.toContain('this.scheduleReconnect()');
  });
});
