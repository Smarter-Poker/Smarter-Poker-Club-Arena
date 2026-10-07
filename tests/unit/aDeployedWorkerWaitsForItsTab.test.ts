/**
 * A DEPLOYED SERVICE WORKER WAITS FOR ITS TAB (2026-10-07).
 *
 * Post-Deploy E2E run 37620236888 failed in global setup with "Club ... did
 * not commit after 2 attempts": the first navigation after a client publish
 * sent no request for two minutes. The page had just booted onto the new
 * release, its sw-bus.js had installed and called skipWaiting(), and the new
 * worker activated while Playwright was navigating the tab away. Run
 * 37579424861 hit the same at 06:10Z and recovered on its retry. Reproduced on
 * two local builds (tests/stale-client): about half of attempts hung with the
 * self-activation, none of 8 without it.
 *
 * The cause is the self-activation, so it is gone: a new worker activates on
 * its own only with no tab open, and an open tab hands over on purpose, from
 * the shell update gate, right before it reloads.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handOverToWaitingWorker, HANDOVER_TIMEOUT_MS } from '../../src/hooks/useShellUpdateGate';

const root = (p: string) => path.resolve(__dirname, '../..', p);
const sw = readFileSync(root('public/sw-bus.js'), 'utf8');
const gate = readFileSync(root('src/hooks/useShellUpdateGate.ts'), 'utf8');

function handler(event: string): string {
  const start = sw.indexOf(`sw.addEventListener('${event}'`);
  expect(start, `sw-bus.js has no ${event} handler`).toBeGreaterThan(-1);
  const next = sw.indexOf('sw.addEventListener(', start + 1);
  return sw.slice(start, next === -1 ? undefined : next);
}

describe('the worker never activates itself under an open tab', () => {
  it('install precaches and does not skipWaiting', () => {
    expect(handler('install')).not.toMatch(/skipWaiting\s*\(/);
  });

  it('skipWaiting is reachable only from a SKIP_WAITING message', () => {
    const calls = sw
      .split('\n')
      .filter((line) => /skipWaiting\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/SKIP_WAITING/);
  });

  it('the gate hands over before it reloads, never the other way round', () => {
    expect(gate).toMatch(
      /handOverToWaitingWorker\(navigator\.serviceWorker\)\.then\(\(\) => window\.location\.reload\(\)\)/
    );
    expect(gate.match(/window\.location\.reload\(\)/g)).toHaveLength(1);
  });
});

function container(waiting: { postMessage: (m: unknown) => void } | null) {
  const listeners = new Set<() => void>();
  return {
    getRegistration: vi.fn(async () =>
      waiting ? ({ waiting } as unknown as ServiceWorkerRegistration) : undefined
    ),
    addEventListener: vi.fn((_: string, fn: () => void) => listeners.add(fn)),
    removeEventListener: vi.fn((_: string, fn: () => void) => listeners.delete(fn)),
    fire: () => [...listeners].forEach((fn) => fn()),
    listeners,
  };
}

describe('handOverToWaitingWorker', () => {
  it('resolves at once when no worker is waiting', async () => {
    expect(await handOverToWaitingWorker(container(null) as never)).toBe('nothing-waiting');
    expect(await handOverToWaitingWorker(undefined)).toBe('nothing-waiting');
  });

  it('asks the waiting worker to activate and resolves when it controls the tab', async () => {
    const waiting = { postMessage: vi.fn() };
    const c = container(waiting);
    const outcome = handOverToWaitingWorker(c as never);
    await vi.waitFor(() =>
      expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    );
    c.fire();
    expect(await outcome).toBe('handed-over');
    expect(c.listeners.size).toBe(0);
  });

  it('is bounded: a worker that never takes over does not hold the reload', async () => {
    vi.useFakeTimers();
    try {
      const c = container({ postMessage: vi.fn() });
      const outcome = handOverToWaitingWorker(c as never);
      await vi.advanceTimersByTimeAsync(HANDOVER_TIMEOUT_MS);
      expect(await outcome).toBe('timed-out');
      expect(c.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable registration is not a reason to skip the reload', async () => {
    const c = container(null);
    c.getRegistration.mockRejectedValueOnce(new Error('blocked'));
    expect(await handOverToWaitingWorker(c as never)).toBe('nothing-waiting');
  });
});
