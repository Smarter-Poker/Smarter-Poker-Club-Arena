import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import {
  raiseEngineAlert,
  resolveEngineAlert,
  firingFingerprints,
  engineAlertDeliverySnapshot,
  persistEngineAlertsBeforeExit,
  engineAlertPrometheusLines,
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

// ── THE PRODUCER IS OBSERVABLE (2026-09-21) ──────────────────────────────────
// On 2026-09-19/20 this producer went 17.8 hours without a delivery. Nothing
// distinguished "down" from "quiet" without ssh: it logged only failures and
// exported no metric. These five series are read on every scrape from memory
// alone and are what the engine-alert-producer rule group evaluates.
const PRODUCER_SERIES = [
  'poker_engine_alerts_journal_sequence',
  'poker_engine_alerts_pending',
  'poker_engine_alerts_active',
  'poker_engine_alerts_last_delivery_timestamp_seconds',
  'poker_engine_alerts_delivery_failures_total',
];
const sample = (lines: string[], name: string): number => {
  const line = lines.find((l) => l.startsWith(name + ' '));
  expect(line, `${name} sample missing from:\n${lines.join('\n')}`).toBeDefined();
  return Number(line!.split(' ')[1]);
};

describe('the engine alert producer is observable on /metrics', () => {
  it('publishes every series at zero from the first scrape, so absence means the exporter is down', () => {
    const lines = engineAlertPrometheusLines();
    for (const name of PRODUCER_SERIES) {
      expect(lines.some((l) => l.startsWith(`# HELP ${name} `) && l.length > 9 + name.length)).toBe(
        true
      );
      expect(lines).toContain(`# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'gauge'}`);
      expect(sample(lines, name)).toBe(0);
    }
  });
  it('follows the journal through failure, acknowledgement and recovery', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(raiseEngineAlert(input)).resolves.toBe(false);
    let lines = engineAlertPrometheusLines();
    expect(sample(lines, 'poker_engine_alerts_journal_sequence')).toBe(2);
    expect(sample(lines, 'poker_engine_alerts_pending')).toBe(1);
    expect(sample(lines, 'poker_engine_alerts_active')).toBe(1);
    expect(sample(lines, 'poker_engine_alerts_delivery_failures_total')).toBe(1);
    expect(sample(lines, 'poker_engine_alerts_last_delivery_timestamp_seconds')).toBe(0);

    fetchMock.mockImplementation(receipt);
    const before = Math.floor(Date.now() / 1000);
    await raiseEngineAlert(input); // same fingerprint: no new event; drains the pending one
    lines = engineAlertPrometheusLines();
    expect(sample(lines, 'poker_engine_alerts_journal_sequence')).toBe(2);
    expect(sample(lines, 'poker_engine_alerts_pending')).toBe(0);
    expect(sample(lines, 'poker_engine_alerts_active')).toBe(1);
    expect(sample(lines, 'poker_engine_alerts_delivery_failures_total')).toBe(1);
    expect(
      sample(lines, 'poker_engine_alerts_last_delivery_timestamp_seconds')
    ).toBeGreaterThanOrEqual(before);

    await expect(resolveEngineAlert(input.alertname, input.component)).resolves.toBe(true);
    lines = engineAlertPrometheusLines();
    expect(sample(lines, 'poker_engine_alerts_journal_sequence')).toBe(3);
    expect(sample(lines, 'poker_engine_alerts_pending')).toBe(0);
    expect(sample(lines, 'poker_engine_alerts_active')).toBe(0);
  });
  it('counts the unconfigured-secret refusal as a delivery failure', async () => {
    vi.stubEnv('ALERT_WEBHOOK_SECRET', '');
    await raiseEngineAlert(input);
    expect(
      sample(engineAlertPrometheusLines(), 'poker_engine_alerts_delivery_failures_total')
    ).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('reads memory only on the scrape path: no journal I/O and no network', () => {
    const load = vi.fn(async () => {
      throw new Error('scrape must not touch the journal');
    });
    const save = vi.fn(async () => {});
    __setEngineAlertJournal({ load, save });
    engineAlertPrometheusLines();
    engineAlertPrometheusLines();
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('is spread into the engine /metrics exposition', () => {
    const source = readFileSync(new URL('../GameServer.ts', import.meta.url), 'utf8');
    expect(sliceEnclosingBlock(source, 'getPrometheusMetrics(): string {')).toContain(
      '...engineAlertPrometheusLines()'
    );
  });
  it('emits every metric the engine-alert-producer rule group reads', () => {
    const rules = readFileSync(
      new URL('../../../infra/monitoring/alert-rules.yml', import.meta.url),
      'utf8'
    );
    const start = rules.indexOf('- name: engine-alert-producer');
    expect(start).toBeGreaterThan(-1);
    const rest = rules.slice(start + 1);
    const next = rest.search(/\n {2}- name: /);
    const group = next === -1 ? rest : rest.slice(0, next);
    // Expressions only, as the CI law does: prose may name a neighbour's series.
    const exprs = [...group.matchAll(/expr: \|\n((?: {10}.*\n)+)/g)].map((m) => m[1]);
    expect(exprs.length).toBe(2);
    const named = exprs.flatMap((e) => [...e.matchAll(/\bpoker_[a-z0-9_]+/g)].map((m) => m[0]));
    expect(named.length).toBeGreaterThan(0);
    const types = engineAlertPrometheusLines().filter((l) => l.startsWith('# TYPE '));
    for (const name of new Set(named)) {
      // GameServer's own gauge: the file-wide maintenance-break guard, not a producer series.
      if (name === 'poker_maintenance_break_active') continue;
      expect(
        types.some((l) => l.startsWith(`# TYPE ${name} `)),
        name
      ).toBe(true);
    }
  });
});
