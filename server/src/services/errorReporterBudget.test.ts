/**
 * Wiring test for the free-tier cut (docs/SENTRY-FREE-TIER-POLICY.md):
 *   - the init options are errors-only (tracesSampleRate 0);
 *   - a reportError whose context is not on the allowlist never touches Sentry;
 *   - the daily budget is inside Sentry's beforeSend (61st dropped, 4th copy
 *     dropped) and the drops are counted for /metrics;
 *   - the allowlist names contexts that actually exist at their call sites.
 * Mocks @sentry/node so no network is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const captured: { exceptions: any[]; initOptions: any } = { exceptions: [], initOptions: null };

vi.mock('@sentry/node', () => ({
  init: (opts: any) => {
    captured.initOptions = opts;
  },
  captureException: (err: unknown, ctx: any) => {
    captured.exceptions.push({ err, ctx });
  },
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
  setContext: vi.fn(),
  flush: vi.fn(async () => true),
  onUncaughtExceptionIntegration: () => ({ name: 'uncaught' }),
  onUnhandledRejectionIntegration: () => ({ name: 'unhandled' }),
}));

beforeEach(() => {
  captured.exceptions = [];
  captured.initOptions = null;
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.SENTRY_DSN = 'https://public@o1.ingest.sentry.io/1';
  delete process.env.SENTRY_BUDGET_PER_KEY;
  delete process.env.SENTRY_BUDGET_GLOBAL;
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

describe('init options: errors only', () => {
  it('tracing is off and no transaction filter exists', async () => {
    await boot();
    expect(captured.initOptions.tracesSampleRate).toBe(0);
    expect(captured.initOptions.beforeSendTransaction).toBeUndefined();
    expect(captured.initOptions.tracePropagationTargets).toBeUndefined();
  });

  it('the old API surface is gone: no reportWarning, no setServerContext, no summary event', async () => {
    const mod = (await import('./errorReporter.js')) as Record<string, unknown>;
    expect(mod.reportWarning).toBeUndefined();
    expect(mod.setServerContext).toBeUndefined();
    expect(mod.flushBudgetSummary).toBeUndefined();
    expect(typeof mod.reportError).toBe('function');
    expect(typeof mod.flushSentry).toBe('function');
  });
});

describe('the context allowlist', () => {
  it('a non-allowlisted context is console-only and never calls Sentry', async () => {
    const { mod } = await boot();
    mod.reportError(new Error('heartbeat late'), 'ServerTableEngine.seat_heartbeat');
    mod.reportError(new Error('ice'), 'VoiceSignal.ice_failed');
    mod.reportError({ message: 'row', code: 'PGRST116' }, 'HorseFleetManager.rotate');
    expect(captured.exceptions).toHaveLength(0);
    expect(console.error).toHaveBeenCalledTimes(3);
    expect(mod.sentryBudgetSnapshot().suppressedTotal).toBe(3);
  });

  it('an allowlisted context reaches captureException with its source and component', async () => {
    const { mod } = await boot();
    mod.reportError(new Error('refused'), 'DB.settle_hand_stacks_conservation_refused', {
      table: 't1',
    });
    mod.reportError(new Error('silent'), 'DealRateVerifier.fleet_silent');
    expect(captured.exceptions).toHaveLength(2);
    expect(captured.exceptions[0].err.message).toBe(
      '[DB.settle_hand_stacks_conservation_refused] refused'
    );
    expect(captured.exceptions[0].ctx.contexts.errorContext).toEqual({
      source: 'DB.settle_hand_stacks_conservation_refused',
      table: 't1',
    });
    expect(captured.exceptions[0].ctx.tags.component).toBe('DB');
    expect(mod.sentryBudgetSnapshot().suppressedTotal).toBe(0);
  });

  it('every allowlisted context is a literal at a real call site (no guessed names)', async () => {
    const { SENTRY_CONTEXT_ALLOWLIST } = await import('./errorReporter.js');
    const root = resolve(__dirname, '..');
    const haystack = execFileSync(
      'grep',
      [
        '-rho',
        '--include=*.ts',
        '--exclude=*.test.ts',
        '--exclude=errorReporter.ts',
        "'[A-Za-z]*\\.[A-Za-z_]*'",
        root,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    const present = new Set(haystack.split('\n').map((s) => s.replace(/'/g, '').trim()));
    const missing = [...SENTRY_CONTEXT_ALLOWLIST].filter((c) => !present.has(c));
    expect(missing, 'allowlist entries with no call site').toEqual([]);
  });

  it('the policy keepers are named', async () => {
    const { SENTRY_CONTEXT_ALLOWLIST } = await import('./errorReporter.js');
    for (const must of [
      'GameServer.Fatal_error',
      'GameServer.Uncaught_exception',
      'GameServer.Unhandled_rejection',
      'GameServer.drain_timed_out',
      'MaintenanceBreak.park_failed',
      'DB.settle_hand_stacks_conservation_refused',
      'DB.settle_hand_stacks_unreachable',
      'Tournament.settle_obligation_transport',
      'TournamentthistournamentIdslic.CRITICAL',
      'DealRateVerifier.fleet_silent',
    ]) {
      expect(SENTRY_CONTEXT_ALLOWLIST.has(must), must).toBe(true);
    }
    // And the noise is not.
    for (const never of [
      'ServerTableEngine.rabbit_hunt_charge_error',
      'GameServer.orphan_table_sweep',
    ]) {
      expect(SENTRY_CONTEXT_ALLOWLIST.has(never), never).toBe(false);
    }
  });
});

describe('the daily budget inside beforeSend', () => {
  it('the fourth identical fingerprint is dropped and counted', async () => {
    const { mod, beforeSend } = await boot();
    const passed = Array.from({ length: 10 }, (_, i) =>
      beforeSend(ev(`[Loop.site] iteration ${i}`), hint(`[Loop.site] iteration ${i}`))
    ).filter(Boolean);
    expect(passed).toHaveLength(3);
    expect(passed[2].tags.sentry_budget_sent_today).toBe('3');
    expect(mod.sentryBudgetSnapshot()).toMatchObject({
      sentToday: 3,
      droppedTotal: 7,
      droppedToday: 7,
    });
  });

  it('the 61st event in a day is dropped and counted, even with distinct contexts', async () => {
    const { mod, beforeSend } = await boot();
    const passed = Array.from({ length: 100 }, (_, i) =>
      beforeSend(ev(`[Site.${i}] boom`, `Site.${i}`), hint(`[Site.${i}] boom`))
    ).filter(Boolean);
    expect(passed).toHaveLength(60);
    expect(mod.sentryBudgetSnapshot()).toMatchObject({ sentToday: 60, droppedTotal: 40 });
    expect(mod.budget.dropped).toBe(40);
  });

  it('flushSentry still flushes, and never sends a summary event', async () => {
    const { mod, beforeSend } = await boot();
    for (let i = 0; i < 10; i++) beforeSend(ev('[Loop.site] x'), hint('[Loop.site] x'));
    const sentry = await import('@sentry/node');
    await mod.flushSentry(10);
    expect(sentry.flush).toHaveBeenCalled();
    expect(sentry.captureMessage).not.toHaveBeenCalled();
    expect(captured.exceptions).toHaveLength(0);
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

describe('the counters reach /metrics', () => {
  it('GameServer publishes the budget as Prometheus gauges', () => {
    const src = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');
    for (const metric of [
      'poker_sentry_events_dropped_total',
      'poker_sentry_events_sent_today',
      'poker_sentry_events_suppressed_total',
    ]) {
      expect(src, metric).toContain(metric);
    }
    expect(src).toContain('sentryBudgetSnapshot()');
  });
});
