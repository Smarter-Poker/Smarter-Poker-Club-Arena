/**
 * Wiring test: the budget is actually inside Sentry's beforeSend, the summary
 * bypasses it, and flushSentry() emits the summary before flushing. Mocks
 * @sentry/node so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured: { messages: any[]; initOptions: any } = { messages: [], initOptions: null };

vi.mock('@sentry/node', () => ({
  init: (opts: any) => {
    captured.initOptions = opts;
  },
  captureException: vi.fn(),
  captureMessage: (msg: string, ctx: any) => {
    captured.messages.push({ msg, ctx });
  },
  addBreadcrumb: vi.fn(),
  setContext: vi.fn(),
  flush: vi.fn(async () => true),
  onUncaughtExceptionIntegration: () => ({ name: 'uncaught' }),
  onUnhandledRejectionIntegration: () => ({ name: 'unhandled' }),
}));

beforeEach(() => {
  captured.messages = [];
  captured.initOptions = null;
  vi.resetModules();
  process.env.SENTRY_DSN = 'https://public@o1.ingest.sentry.io/1';
  process.env.SENTRY_BUDGET_PER_KEY = '3';
  process.env.SENTRY_BUDGET_GLOBAL = '5';
});

async function boot() {
  const mod = await import('./errorReporter.js');
  mod.initSentry();
  expect(captured.initOptions?.beforeSend, 'beforeSend must be installed').toBeTypeOf('function');
  return { mod, beforeSend: captured.initOptions.beforeSend as (e: any, h: any) => any };
}

const ev = (message: string, source?: string, tags: Record<string, string> = {}) => ({
  message,
  tags,
  contexts: source ? { errorContext: { source } } : {},
});
const hint = (message: string) => ({ originalException: new Error(message) });

describe('errorReporter budget wiring', () => {
  it('throttles a loop at the per-key limit inside beforeSend', async () => {
    const { beforeSend } = await boot();
    const passed = Array.from({ length: 50 }, (_, i) =>
      beforeSend(ev(`[Loop.site] iteration ${i}`), hint(`[Loop.site] iteration ${i}`))
    ).filter(Boolean);
    expect(passed).toHaveLength(3);
  });

  it('caps everything at the global limit even with distinct contexts', async () => {
    const { beforeSend } = await boot();
    const passed = Array.from({ length: 50 }, (_, i) =>
      beforeSend(ev(`[Site.${i}] boom`, `Site.${i}`), hint(`[Site.${i}] boom`))
    ).filter(Boolean);
    expect(passed).toHaveLength(5);
  });

  it('the budget summary always passes and reports what was dropped', async () => {
    const { mod, beforeSend } = await boot();
    for (let i = 0; i < 40; i++) beforeSend(ev('[Loop.site] x'), hint('[Loop.site] x'));
    for (let i = 0; i < 40; i++) beforeSend(ev('[Loop.two] x'), hint('[Loop.two] x'));
    // Per-key (3) and global (5) budgets exhausted; a normal event is dropped...
    expect(beforeSend(ev('[Other] y'), hint('[Other] y'))).toBeNull();
    // ...but the summary is not.
    const summary = ev('[SentryBudget] dropped', undefined, { sentry_budget_summary: 'true' });
    expect(beforeSend(summary, { originalException: undefined })).toBe(summary);

    expect(mod.flushBudgetSummary()).toBe(true);
    expect(captured.messages).toHaveLength(1);
    const { msg, ctx } = captured.messages[0];
    expect(msg).toMatch(/dropped 76 engine event/);
    expect(ctx.tags.sentry_budget_summary).toBe('true');
    expect(ctx.contexts.sentryBudget.total).toBe(76);
    expect(ctx.contexts.sentryBudget.top[0]).toEqual({ key: 'Loop.two|x', dropped: 38 });
    expect(ctx.contexts.sentryBudget.top[1]).toEqual({ key: 'Loop.site|x', dropped: 37 });
    expect(ctx.contexts.sentryBudget.top[2]).toEqual({ key: 'Other|y', dropped: 1 });
    // Nothing new dropped: no second summary.
    expect(mod.flushBudgetSummary()).toBe(false);
  });

  it('flushSentry emits the pending summary before flushing (restart safety)', async () => {
    const { mod, beforeSend } = await boot();
    for (let i = 0; i < 10; i++) beforeSend(ev('[Loop.site] x'), hint('[Loop.site] x'));
    await mod.flushSentry(10);
    expect(captured.messages).toHaveLength(1);
    expect(captured.messages[0].ctx.contexts.sentryBudget.total).toBe(7);
  });

  it('keeps the existing transient-Supabase rule (1/min/message, warning level)', async () => {
    const { beforeSend } = await boot();
    const a = beforeSend(ev('[Db] fetch failed'), hint('[Db] fetch failed'));
    const b = beforeSend(ev('[Db] fetch failed'), hint('[Db] fetch failed'));
    expect(a?.level).toBe('warning');
    expect(b).toBeNull();
    expect(beforeSend(ev('x EPIPE y'), hint('x EPIPE y'))).toBeNull();
  });
});
