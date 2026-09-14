import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import {
  raiseEngineAlert,
  resolveEngineAlert,
  firingFingerprints,
  engineAlertDeliverySnapshot,
  persistEngineAlertsBeforeExit,
  __setEngineAlertJournal,
  __resetEngineAlerts,
} from './engineAlerts.js';
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
const fetchMock = vi.fn();
const input = {
  alertname: 'ClubArenaFleetSilent',
  severity: 'critical' as const,
  component: 'club-arena-engine',
  summary: 'zero hands',
};
const receipt = (_url: string, options: { body: string }) => {
  const alert = JSON.parse(options.body).alerts[0];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      recorded: 1,
      db: 'ok',
      destination: 'codex',
      receipts: [{ id: 42, event_id: alert.labels.engine_alert_event_id }],
    }),
  };
};
beforeEach(() => {
  vi.stubEnv('ALERT_WEBHOOK_SECRET', 'test-secret');
  vi.stubGlobal('fetch', fetchMock);
  __resetEngineAlerts();
  fetchMock.mockReset().mockImplementation(receipt);
});
afterEach(() => {
  __resetEngineAlerts();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('engine alert receipt and routing contract', () => {
  it('fires once and resolves once after real durable receipts', async () => {
    await expect(raiseEngineAlert(input)).resolves.toBe(true);
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    expect(firingFingerprints()).toEqual(['ClubArenaFleetSilent:club-arena-engine']);
    await expect(resolveEngineAlert(input.alertname, input.component)).resolves.toBe(true);
    expect(firingFingerprints()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(engineAlertDeliverySnapshot().pending).toBe(0);
  });
  it.each([
    null,
    {},
    { ok: true },
    { ok: true, recorded: 0, db: 'ok', destination: 'codex' },
    { ok: true, recorded: 1, db: 'ok', destination: 'codex' },
    {
      ok: true,
      recorded: 1,
      db: 'ok',
      destination: 'codex',
      receipts: [{ id: 1, event_id: 'wrong-event' }],
    },
  ])('retains an event after a false successful HTTP receipt: %j', async (body) => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => body });
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    expect(engineAlertDeliverySnapshot().pending).toBe(1);
  });
  it('never throws when the receiver fails, and retains its stable event for retry', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    const first = fetchMock.mock.calls[0][1].body;
    fetchMock.mockImplementation(receipt);
    await raiseEngineAlert(input);
    expect(fetchMock.mock.calls[1][1].body).toBe(first);
    expect(engineAlertDeliverySnapshot().pending).toBe(0);
  });
  it('bounds a receiver whose successful response body never completes', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, options) => ({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(new Error('aborted')))
        ),
    }));
    const result = raiseEngineAlert(input);
    await vi.advanceTimersByTimeAsync(8001);
    await expect(result).resolves.toBe(false);
    expect(engineAlertDeliverySnapshot().pending).toBe(1);
  });
  it('keeps delivery and bounded shutdown nonthrowing when logging is broken', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    fetchMock.mockRejectedValue(new Error('offline'));
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    expect(engineAlertDeliverySnapshot().pending).toBe(1);
    __setEngineAlertJournal({
      load: async () => {
        throw new Error('EIO');
      },
      save: async () => {},
    });
    await expect(persistEngineAlertsBeforeExit()).resolves.toBe(false);
  });
  it('keeps unconfigured alerts pending without attempting a network call', async () => {
    vi.stubEnv('ALERT_WEBHOOK_SECRET', '');
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(engineAlertDeliverySnapshot().pending).toBe(1);
    vi.stubEnv('ALERT_WEBHOOK_SECRET', 'restored');
    await raiseEngineAlert(input);
    expect(engineAlertDeliverySnapshot().pending).toBe(0);
  });
  it('retains page priority for both failure and recovery in Codex, with no phone mirror', async () => {
    await raiseEngineAlert({ ...input, page: true });
    await resolveEngineAlert(input.alertname, input.component);
    const alerts = fetchMock.mock.calls.map(([url, options]) => {
      expect(url).toBe('https://smarter.poker/api/alerts/engine');
      return JSON.parse(options.body).alerts[0];
    });
    expect(alerts.map((alert) => alert.labels.engine_alert_priority)).toEqual(['page', 'page']);
    const source = readFileSync(new URL('./engineAlerts.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('fn_raise_notification');
    expect(source).not.toContain('ca_incident_recipients');
    const caller = readFileSync(new URL('./DealRateVerifier.ts', import.meta.url), 'utf8');
    for (const name of ['ClubArenaFleetFloorLost', 'ClubArenaFleetSilent']) {
      expect(sliceEnclosingBlock(caller, "alertname: '" + name + "'")).toContain('page: true');
    }
  });
  it('settles journal writes after gameplay ownership release and before process exit', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const shutdown = sliceEnclosingBlock(source, 'await gameServer.stop();');
    expect(shutdown.indexOf('await persistEngineAlertsBeforeExit()')).toBeGreaterThan(
      shutdown.indexOf('await gameServer.stop()')
    );
    expect(shutdown.indexOf('process.exit(')).toBeGreaterThan(
      shutdown.indexOf('await persistEngineAlertsBeforeExit()')
    );
  });
});
