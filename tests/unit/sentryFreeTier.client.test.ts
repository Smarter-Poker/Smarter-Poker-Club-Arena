/**
 * Sentry on the free tier - the client side of docs/SENTRY-FREE-TIER-POLICY.md.
 *
 * 5,000 errors a month for the whole org. These pins are what keep this client
 * inside its 40-a-day share:
 *   - replays and tracing are OFF in the init options, not sampled low;
 *   - a reportError whose context is not on the allowlist never reaches Sentry;
 *   - beforeSend enforces 2 per session, 3 per fingerprint per day, 40 per day,
 *     with the daily count surviving a reload via localStorage;
 *   - nothing is dropped by error CLASS.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sentryMock = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(() => 'evt-1'),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setUser: vi.fn(),
  showReportDialog: vi.fn(),
  withScope: vi.fn((cb: (scope: unknown) => void) => cb({ setContext: vi.fn() })),
  globalHandlersIntegration: vi.fn((opts: unknown) => ({ name: 'GlobalHandlers', opts })),
  replayIntegration: vi.fn(() => ({ name: 'Replay' })),
  reactRouterV6BrowserTracingIntegration: vi.fn(() => ({ name: 'BrowserTracing' })),
}));

vi.mock('@sentry/react', () => sentryMock);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* the setup mock always has clear */
  }
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@o1.ingest.sentry.io/1');
  vi.stubEnv('VITE_APP_ENV', 'production');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the init options: errors only', () => {
  it('turns replay and tracing off and samples a quarter of errors', async () => {
    const mod = await import('../../src/core/SentryInit');
    const surface = await mod.getSentryAsync();
    expect(surface, 'with a DSN the surface loads').not.toBeNull();
    expect(sentryMock.init).toHaveBeenCalledTimes(1);
    const opts = sentryMock.init.mock.calls[0][0] as Record<string, unknown>;

    expect(opts.tracesSampleRate).toBe(0);
    expect(opts.replaysSessionSampleRate).toBe(0);
    expect(opts.replaysOnErrorSampleRate).toBe(0);
    expect(opts.sampleRate).toBe(0.25);
    expect(opts.beforeSendTransaction, 'transactions are off; nothing to filter').toBeUndefined();
    expect(opts.tracePropagationTargets, 'no tracing headers on any request').toBeUndefined();

    const integrations = (opts.integrations as Array<{ name: string }>).map((i) => i.name);
    expect(integrations).not.toContain('Replay');
    expect(integrations).not.toContain('BrowserTracing');
    expect(sentryMock.replayIntegration).not.toHaveBeenCalled();
    expect(sentryMock.reactRouterV6BrowserTracingIntegration).not.toHaveBeenCalled();
    // The unhandled-rejection hook is main.tsx's job (reportError, allowlisted);
    // Sentry's own copy would spend the second of the session's two events.
    expect(sentryMock.globalHandlersIntegration).toHaveBeenCalledWith({
      onerror: true,
      onunhandledrejection: false,
    });
  });

  it('the surface no longer exports Replay, BrowserTracing, spans or measurements', async () => {
    const bundle = (await import('../../src/core/sentryBundle')) as Record<string, unknown>;
    for (const gone of [
      'replayIntegration',
      'reactRouterV6BrowserTracingIntegration',
      'startSpan',
      'setMeasurement',
      'setContext',
      'setTags',
    ]) {
      expect(bundle[gone], `${gone} must not be reachable from the app`).toBeUndefined();
    }
  });
});

describe('the context allowlist in reportError', () => {
  it('a non-allowlisted context is console-only and never calls Sentry', async () => {
    const mod = await import('../../src/core/SentryInit');
    await mod.getSentryAsync();
    const { reportError, getSuppressedReportCount } = await import('../../src/utils/errorReporter');

    reportError(new Error('ice failed'), 'VoiceSignalService.fetchVoiceIceConfig');
    reportError(new Error('sort failed'), 'CarouselSection.sort');
    reportError({ message: 'row missing', code: 'PGRST116' }, 'ClubService.getClub');

    expect(sentryMock.captureException).not.toHaveBeenCalled();
    expect(getSuppressedReportCount()).toBe(3);
    expect(console.error).toHaveBeenCalledTimes(3);
    // Said once per context, not once per call.
    reportError(new Error('again'), 'CarouselSection.sort');
    const notices = (console.warn as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes('not on the Sentry allowlist')
    );
    expect(notices).toHaveLength(3);
  });

  it('an allowlisted context reaches captureException with its source', async () => {
    const mod = await import('../../src/core/SentryInit');
    await mod.getSentryAsync();
    const { reportError, SENTRY_CONTEXT_ALLOWLIST } = await import('../../src/utils/errorReporter');

    reportError(new Error('boom'), 'PageErrorBoundary.crash', { pageName: 'Lobby' });
    reportError(
      { success: false, error: 'insufficient chips' },
      'TablePage.atomic_table_buyin_returned_failure'
    );

    expect(sentryMock.captureException).toHaveBeenCalledTimes(2);
    const [err, ctx] = sentryMock.captureException.mock.calls[0] as [Error, Record<string, any>];
    expect(err.message).toBe('[PageErrorBoundary.crash] boom');
    expect(ctx.contexts.errorContext.source).toBe('PageErrorBoundary.crash');
    expect(ctx.contexts.errorContext.pageName).toBe('Lobby');

    // The policy's three keepers, pinned by name.
    for (const must of [
      'PageErrorBoundary.crash',
      'RouteErrorBoundary.crash',
      'TableErrorBoundary.crash',
      'main.Unhandled_promise_rejection_caught',
    ]) {
      expect(SENTRY_CONTEXT_ALLOWLIST.has(must), must).toBe(true);
    }
  });

  it('every boundary and the global net actually use an allowlisted context', async () => {
    const { readFileSync } = await import('node:fs');
    const { SENTRY_CONTEXT_ALLOWLIST } = await import('../../src/utils/errorReporter');
    const sites: Array<[string, string]> = [
      ['src/components/common/PageErrorBoundary.tsx', 'PageErrorBoundary.crash'],
      ['src/components/common/RouteErrorBoundary.tsx', 'RouteErrorBoundary.crash'],
      ['src/components/common/TableErrorBoundary.tsx', 'TableErrorBoundary.crash'],
      ['src/main.tsx', 'main.Unhandled_promise_rejection_caught'],
    ];
    for (const [file, context] of sites) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} reports as ${context}`).toContain(`'${context}'`);
      expect(SENTRY_CONTEXT_ALLOWLIST.has(context)).toBe(true);
    }
  });
});

describe('the client budget in beforeSend', () => {
  const hint = (message: string) => ({ originalException: new Error(message) });
  const ev = (message: string, source?: string) => ({
    message,
    contexts: source ? { errorContext: { source } } : {},
    tags: {},
  });

  it('two events per session, then everything is dropped', async () => {
    const { clientBeforeSend, clientBudget } = await import('../../src/core/SentryInit');
    const verdicts = ['a', 'b', 'c', 'd'].map((m) =>
      clientBeforeSend(ev(`[Site.${m}] boom`, `Site.${m}`), hint(`[Site.${m}] boom`))
    );
    expect(verdicts.map(Boolean)).toEqual([true, true, false, false]);
    expect(clientBudget.dropped).toBe(2);
  });

  it('the fourth identical fingerprint in a day is dropped, across sessions', async () => {
    const { SentryClientBudget } = await import('../../src/core/sentryClientBudget');
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const now = () => Date.UTC(2026, 8, 4, 12, 0, 0);
    // Three sessions (page loads), same error each time: sessions do not reset
    // the per-fingerprint count because it lives in storage.
    const results: boolean[] = [];
    for (let session = 0; session < 4; session++) {
      const b = new SentryClientBudget({ storage, now, perSessionLimit: 10 });
      results.push(b.admit('Site.x|boom').allow);
    }
    expect(results).toEqual([true, true, true, false]);
    // A different fingerprint is still fine.
    expect(new SentryClientBudget({ storage, now }).admit('Site.y|other').allow).toBe(true);
  });

  it('forty a day, persisted, reset at the UTC day boundary', async () => {
    const { SentryClientBudget, CLIENT_DAILY_BUDGET, CLIENT_BUDGET_STORAGE_KEY } =
      await import('../../src/core/sentryClientBudget');
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    let t = Date.UTC(2026, 8, 4, 23, 59, 0);
    const mk = () => new SentryClientBudget({ storage, now: () => t, perSessionLimit: 1_000 });

    let sent = 0;
    for (let i = 0; i < 100; i++) if (mk().admit(`Site.${i}|x`).allow) sent++;
    expect(sent).toBe(CLIENT_DAILY_BUDGET);
    expect(JSON.parse(store.get(CLIENT_BUDGET_STORAGE_KEY)!).day).toBe('2026-09-04');
    expect(mk().admit('Site.new|x')).toMatchObject({ allow: false, reason: 'daily' });

    // Two minutes later it is the 5th in UTC: fresh bucket.
    t += 2 * 60_000;
    expect(mk().admit('Site.new|x').allow).toBe(true);
    expect(JSON.parse(store.get(CLIENT_BUDGET_STORAGE_KEY)!).day).toBe('2026-09-05');
  });

  it('a hostile localStorage (corrupt, throwing, absent) never breaks admission', async () => {
    const { SentryClientBudget, CLIENT_BUDGET_STORAGE_KEY } =
      await import('../../src/core/sentryClientBudget');
    const corrupt = {
      getItem: () => '{"day": 12, "sent": "lots"',
      setItem: () => {},
    };
    expect(new SentryClientBudget({ storage: corrupt }).admit('k').allow).toBe(true);

    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const b = new SentryClientBudget({ storage: throwing, perSessionLimit: 5 });
    expect([1, 2, 3, 4].map(() => b.admit('k').allow)).toEqual([true, true, true, false]);

    expect(new SentryClientBudget({ storage: null }).admit('k').allow).toBe(true);
    void CLIENT_BUDGET_STORAGE_KEY;
  });

  it('nothing is dropped by error class; known noise is dropped by name', async () => {
    const { clientBeforeSend } = await import('../../src/core/SentryInit');
    // A real null-deref from production code is an event (the old /src/-gated
    // drop threw these away once source maps stopped shipping).
    const nullDeref = new TypeError("Cannot read properties of null (reading 'stack')");
    nullDeref.stack =
      'TypeError: ...\n    at https://smarter.poker/hub/club-arena/assets/index-abc123.js:1:2';
    expect(
      clientBeforeSend(ev(nullDeref.message), { originalException: nullDeref })
    ).not.toBeNull();

    const ref = new ReferenceError('foo is not defined');
    expect(clientBeforeSend(ev(ref.message), { originalException: ref })).not.toBeNull();

    // Named noise still goes.
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(clientBeforeSend(ev('x'), { originalException: abort })).toBeNull();
    expect(clientBeforeSend(ev('Failed to fetch'), hint('Failed to fetch'))).toBeNull();
  });

  it('the uncaught-exception fallback fingerprint is the message head', async () => {
    const { clientFingerprintOf } = await import('../../src/core/sentryClientBudget');
    expect(clientFingerprintOf('[TablePage.Buyin_FAILED] seat 4 at table 9c1f2e3d4a5b6c7d')).toBe(
      'TablePage.Buyin_FAILED|seat # at table <hex>'
    );
    expect(clientFingerprintOf('TypeError: x is not a function')).toBe(
      'TypeError: x is not a function'
    );
    expect(clientFingerprintOf('')).toBe('(empty)');
  });
});
