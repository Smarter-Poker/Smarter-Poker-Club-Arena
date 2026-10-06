/**
 * The first-party client error sink (2026-10-03): scrubbing, batching,
 * repeat sampling and the client-side rate limit. The database enforces its
 * own caps and scrubbing independently - scripts/ci/test-client-error-sink.py
 * qualifies those against a real PostgreSQL 17.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createClientErrorSink,
  dedupeKey,
  scrubContext,
  scrubText,
  signedInAccessToken,
  SINK_LIMITS,
  toSinkEvent,
  type ClientErrorCapture,
  type SinkEvent,
} from '../../src/utils/clientErrorSink';
import { captureClientError, reportError } from '../../src/utils/errorReporter';

const ENV = { appVersion: 'abc123', userAgent: 'UA/1', automated: false };

function capture(over: Partial<ClientErrorCapture> = {}): ClientErrorCapture {
  return {
    at: 1_000,
    route: '/hub/club-arena/table/t1',
    code: 'ACTION_CONTEXT_REQUIRED',
    name: 'Error',
    message: 'Action needs its context',
    stack: null,
    source: 'TablePage.action_error_shown',
    ...over,
  };
}

function harness() {
  let now = 0;
  let timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const sends: Array<{ events: SinkEvent[]; keepalive: boolean }> = [];
  const sink = createClientErrorSink({
    ...ENV,
    send: (events, keepalive) => sends.push({ events, keepalive }),
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimer: (id) => {
      timers = timers.filter((t) => t.id !== id);
    },
  });
  const advance = (ms: number) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    for (const t of due) t.fn();
  };
  return { sink, sends, advance, pendingTimers: () => timers.length };
}

describe('scrubbing', () => {
  it('removes emails, JWTs, bearer tokens, secret values and long opaque tokens', () => {
    const out = scrubText(
      'player bob@example.com jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln Bearer abc.def-123 ' +
        'refresh_token=v1xyz&ok=1 password=hunter2 sb_publishable__41LpJpzrfrb3hSUpEaYCA_tF53bBJx',
      500
    );
    expect(out).toBe(
      'player [email] jwt [jwt] Bearer [token] refresh_token=[redacted]&ok=1 password=[redacted] [token]'
    );
  });

  it('keeps what diagnosis needs: UUIDs, codes, short ids, plain words', () => {
    const text =
      'table 0b6a0f0e-1c1d-4e5f-8a9b-0c1d2e3f4a5b refused SEAT_OCCUPANCY_REQUIRED seat 3 (status 400)';
    expect(scrubText(text, 500)).toBe(text);
    // a long identifier with no digit is not a token
    expect(scrubText('TablePage.Supabase_VITE_SUPABASE_URL_and_VITE_SUPA', 500)).toBe(
      'TablePage.Supabase_VITE_SUPABASE_URL_and_VITE_SUPA'
    );
  });

  it('caps length after scrubbing', () => {
    expect(scrubText('x'.repeat(5_000), SINK_LIMITS.message)).toHaveLength(SINK_LIMITS.message);
  });

  it('redacts sensitive keys, bounds depth/size and survives hostile objects', () => {
    const hostile = {
      get boom() {
        throw new Error('getter');
      },
    };
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const ctx = scrubContext({
      email: 'a@b.co',
      accessToken: 'abc',
      note: 'contact bob@example.com',
      tableId: 't1',
      hostile,
      circular,
      big: 10n,
      list: Array.from({ length: 50 }, (_, i) => i),
      deep: { a: { b: { c: { d: 1 } } } },
    })!;
    expect(ctx.email).toBe('[redacted]');
    expect(ctx.accessToken).toBe('[redacted]');
    expect(ctx.note).toBe('contact [email]');
    expect(ctx.tableId).toBe('t1');
    expect(ctx.hostile).toEqual({ boom: '[unreadable]' });
    expect(ctx.big).toBe('10');
    expect(ctx.list).toHaveLength(SINK_LIMITS.contextArray);
    expect(JSON.stringify(ctx.deep)).toBe('{"a":{"b":"[object]"}}');
    expect(JSON.stringify(ctx.circular)).toContain('[object]');
    const rows = Array.from({ length: 10 }, () => 'y'.repeat(190));
    expect(scrubContext({ a: rows, b: rows })).toEqual({
      truncated: true,
    });
    expect(scrubContext(undefined)).toBeUndefined();
  });

  it('builds a wire event with no query string, sanitized code and a stable dedupe key', () => {
    const e = toSinkEvent(
      capture({
        route: '/table/1?access_token=x#y',
        code: 'BAD CODE;drop',
        message: 'seat 3 failed',
      }),
      ENV
    );
    expect(e.route).toBe('/table/1');
    expect(e.code).toBe('BAD_CODE_drop');
    expect(e.app_version).toBe('abc123');
    // digits are folded: "seat 3" and "seat 4" are one problem
    expect(e.dedupe_key).toBe(dedupeKey('BAD_CODE_drop', e.source, 'seat 4 failed'));
    expect(e.dedupe_key).not.toBe(dedupeKey('BAD_CODE_drop', e.source, 'leave failed'));
    expect(e.dedupe_key).toMatch(/^[A-Za-z0-9_.:|-]{1,64}$/);
  });
});

describe('batching', () => {
  it('sends nothing until the debounce window closes, then one request', () => {
    const { sink, sends, advance } = harness();
    sink.enqueue(capture({ message: 'a' }));
    sink.enqueue(capture({ message: 'b' }));
    sink.enqueue(capture({ message: 'c' }));
    expect(sends).toHaveLength(0);
    advance(SINK_LIMITS.debounceMs);
    expect(sends).toHaveLength(1);
    expect(sends[0].keepalive).toBe(false);
    expect(sends[0].events.map((e) => e.message)).toEqual(['a', 'b', 'c']);
  });

  it('splits a large queue into batches of at most ten', () => {
    const { sink, sends, advance } = harness();
    for (let i = 0; i < 25; i++)
      sink.enqueue(capture({ message: `distinct problem ${'z'.repeat(i)}` }));
    advance(SINK_LIMITS.debounceMs);
    expect(sends.map((s) => s.events.length)).toEqual([10, 10, 5]);
  });

  it('flushes with keepalive on page hide, one batch at most', () => {
    const { sink, sends, pendingTimers } = harness();
    for (let i = 0; i < 15; i++) sink.enqueue(capture({ message: `p ${'q'.repeat(i)}` }));
    sink.flush(true);
    expect(pendingTimers()).toBe(0);
    expect(sends).toHaveLength(1);
    expect(sends[0].keepalive).toBe(true);
    expect(sends[0].events).toHaveLength(SINK_LIMITS.batch);
    expect(sink.stats().queued).toBe(0);
  });

  it('never throws, even when sending does', () => {
    const sink = createClientErrorSink({
      ...ENV,
      send: () => {
        throw new Error('network gone');
      },
      now: () => 0,
      setTimer: () => 1,
      clearTimer: () => {},
    });
    expect(() => sink.enqueue(capture())).not.toThrow();
    expect(() => sink.flush(false)).not.toThrow();
    expect(() => sink.flush(true)).not.toThrow();
    expect(() => sink.enqueue(null as unknown as ClientErrorCapture)).not.toThrow();
  });
});

describe('repeat sampling and rate limit', () => {
  it('sends one event per key per minute and carries the repeats as occurrences', () => {
    const { sink, sends, advance } = harness();
    for (let i = 0; i < 5; i++) sink.enqueue(capture());
    advance(SINK_LIMITS.debounceMs);
    expect(sends.flatMap((s) => s.events)).toHaveLength(1);
    expect(sink.stats().suppressed).toBe(4);

    advance(SINK_LIMITS.repeatWindowMs);
    sink.enqueue(capture());
    advance(SINK_LIMITS.debounceMs);
    const all = sends.flatMap((s) => s.events);
    expect(all).toHaveLength(2);
    expect(all[1].occurrences).toBe(5); // four carried + this one
  });

  it('reports the unsent repeats on page hide', () => {
    const { sink, sends, advance } = harness();
    for (let i = 0; i < 3; i++) sink.enqueue(capture());
    advance(SINK_LIMITS.debounceMs);
    sink.flush(true);
    const last = sends[sends.length - 1];
    expect(last.keepalive).toBe(true);
    expect(last.events).toHaveLength(1);
    expect(last.events[0].occurrences).toBe(2);
  });

  it('holds 30 events a minute; the excess is counted, not sent', () => {
    const { sink, sends, advance } = harness();
    for (let i = 0; i < 45; i++) sink.enqueue(capture({ message: `problem ${'w'.repeat(i)}` }));
    advance(SINK_LIMITS.debounceMs);
    expect(sends.flatMap((s) => s.events)).toHaveLength(SINK_LIMITS.perMinute);
    expect(sink.stats().suppressed).toBe(15);
    advance(60_000);
    sink.enqueue(capture({ message: 'fresh problem' }));
    advance(SINK_LIMITS.debounceMs);
    expect(sends.flatMap((s) => s.events)).toHaveLength(SINK_LIMITS.perMinute + 1);
  });

  it('stops at 200 events a page session', () => {
    const { sink, sends, advance } = harness();
    for (let minute = 0; minute < 10; minute++) {
      for (let i = 0; i < 30; i++)
        sink.enqueue(capture({ message: `m${minute} ${'v'.repeat(i)}` }));
      advance(60_000);
    }
    expect(sends.flatMap((s) => s.events)).toHaveLength(SINK_LIMITS.perSession);
  });
});

describe('signed-in sessions only', () => {
  it('reads the shared session token and refuses a missing or expiring one', () => {
    const now = 1_700_000_000_000;
    localStorage.removeItem('smarter-poker-auth');
    expect(signedInAccessToken(now)).toBeNull();
    localStorage.setItem(
      'smarter-poker-auth',
      JSON.stringify({ access_token: 'tok', expires_at: now / 1000 + 3600 })
    );
    expect(signedInAccessToken(now)).toBe('tok');
    localStorage.setItem(
      'smarter-poker-auth',
      JSON.stringify({ access_token: 'tok', expires_at: now / 1000 + 10 })
    );
    expect(signedInAccessToken(now)).toBeNull();
    localStorage.setItem('smarter-poker-auth', '{not json');
    expect(signedInAccessToken(now)).toBeNull();
    localStorage.removeItem('smarter-poker-auth');
  });

  it('does not link the account modules (the Diamond test page must not)', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src/utils/clientErrorSink.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"][^'"]*lib\/(authUtils|supabase)['"]/);
  });
});

describe('errorReporter forwarding', () => {
  it('is inert outside a production build and never throws', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      }
    );
    expect(() => captureClientError(hostile, 'test.capture', { code: 'X' })).not.toThrow();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportError(hostile, 'test.report', { code: 'X' })).not.toThrow();
    spy.mockRestore();
  });
});

describe('the sink is first-party only', () => {
  const ROOT = join(__dirname, '..', '..');
  const files = ['src/utils/clientErrorSink.ts', 'src/utils/errorReporter.ts'];

  it('talks to our own Supabase RPC and nothing else', () => {
    const sink = readFileSync(join(ROOT, files[0]), 'utf8');
    expect(sink).toContain('/rest/v1/rpc/fn_report_client_errors');
    expect(sink).toContain('import.meta.env.VITE_SUPABASE_URL');
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf8').replace(/^\s*(\*|\/\/).*$/gm, '');
      expect(src, f).not.toMatch(/https?:\/\//);
      expect(src.toLowerCase(), f).not.toContain('sentry');
      expect(src, f).not.toMatch(/sendBeacon|XMLHttpRequest/);
    }
  });
});
