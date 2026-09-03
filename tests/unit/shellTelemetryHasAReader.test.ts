/**
 * ═══ THE FIX THAT IS INVISIBLE WHEN IT WORKS NEEDS A READER ════════════════
 *
 * `useShellUpdateGate` has emitted SHELL_STALENESS_CHECKED and SHELL_RELOADED
 * since 2026-08-29 and NOTHING SUBSCRIBED — the same shape as SHELL_UPDATED
 * itself, which the service worker posted for months to a client with no
 * handler. The open-from-Hub glitch fix produces no visible signal when it is
 * working (the point is that no reload happens), so with no sink there is no
 * way to tell "holding" from "quietly broken".
 *
 * These pin the reader: it is subscribed at the app root, it is throttled, it
 * refuses to write when signed out (RLS would refuse it anyway), and above
 * all it can never throw into the app.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  mayWrite,
  MIN_WRITE_INTERVAL_MS,
  writeReloadBeacon,
  __resetShellTelemetryForTests,
} from '../../src/services/ShellTelemetryService';

beforeEach(() => {
  __resetShellTelemetryForTests();
});

describe('the writer is throttled', () => {
  it('allows the first write of a kind', () => {
    expect(mayWrite('reloaded', 1_000_000, undefined)).toBe(true);
  });

  it('refuses a second write inside the interval, allows one after', () => {
    const now = 1_000_000;
    expect(mayWrite('reloaded', now, now - MIN_WRITE_INTERVAL_MS + 1)).toBe(false);
    expect(mayWrite('reloaded', now, now - MIN_WRITE_INTERVAL_MS - 1)).toBe(true);
  });

  it('the interval is load-bearing — a KPI must not become a write storm', () => {
    expect(MIN_WRITE_INTERVAL_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('telemetry can never break the app', () => {
  it('the reload beacon swallows a hostile environment instead of throwing', async () => {
    // No session, no fetch, nothing: it must still resolve quietly.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      await expect(writeReloadBeacon(1234)).resolves.toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('the wiring', () => {
  const app = readFileSync(path.resolve(__dirname, '../../src/App.tsx'), 'utf8');
  const svc = readFileSync(
    path.resolve(__dirname, '../../src/services/ShellTelemetryService.ts'),
    'utf8'
  );

  it('is started at the app root, beside the gate that produces the events', () => {
    expect(app.includes('startShellTelemetry')).toBe(true);
    expect(
      app.indexOf('useShellUpdateGate()'),
      'the telemetry is started before the gate exists'
    ).toBeLessThan(app.indexOf('startShellTelemetry()'));
  });

  it('subscribes to BOTH events the gate emits', () => {
    expect(svc.includes("subscribe('SHELL_STALENESS_CHECKED'")).toBe(true);
    expect(svc.includes("subscribe('SHELL_RELOADED'")).toBe(true);
  });

  it('the reload write uses keepalive — the page is about to be replaced', () => {
    expect(
      /keepalive: true/.test(svc),
      'a plain insert is cancelled by the reload it is recording'
    ).toBe(true);
  });

  it('never writes without a signed-in user (RLS requires user_id = auth.uid())', () => {
    expect(/if \(!userId\) return;/.test(svc)).toBe(true);
  });

  it('every write path is wrapped so telemetry cannot surface to the player', () => {
    // Both write functions must contain a catch that does nothing loud.
    const catches = svc.match(/\} catch \{/g) ?? [];
    expect(catches.length).toBeGreaterThanOrEqual(3);
    expect(
      svc.includes('reportError'),
      'telemetry must not report its own failures as errors'
    ).toBe(false);
  });
});

describe('the migration ships with the code that needs it', () => {
  it('the table and both KPI views are in the repo migration', () => {
    const sql = readFileSync(
      path.resolve(__dirname, '../../supabase/migrations/20260830_client_shell_telemetry.sql'),
      'utf8'
    );
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.client_shell_telemetry/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_shell_staleness_rate/);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.v_shell_reload_lateness/);
    // RLS, or any signed-in user could write rows as anybody.
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/WITH CHECK \(user_id = auth\.uid\(\)\)/);
  });
});
