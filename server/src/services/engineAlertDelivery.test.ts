import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineAlertDelivery, MemoryAlertJournal } from './engineAlertDelivery.js';
import {
  emptyAlertJournal,
  type AlertJournalState,
  type JournalAlert,
} from './engineAlertJournal.js';

const input = {
  alertname: 'FleetStopped',
  component: 'horses',
  severity: 'critical' as const,
  summary: 'No progress',
};
const deliveries: EngineAlertDelivery[] = [];
afterEach(() => {
  for (const delivery of deliveries) delivery.stop();
  deliveries.length = 0;
});
function setup(store = new MemoryAlertJournal(emptyAlertJournal()), automatic = false) {
  let id = 0;
  const post = vi.fn<(alert: JournalAlert) => Promise<boolean>>().mockResolvedValue(false);
  const report = vi.fn();
  const raised = vi.fn();
  const delivery = new EngineAlertDelivery({
    store,
    post,
    report,
    raised,
    automatic,
    retryMs: 10,
    id: () => `event-${++id}`,
    now: () => '2026-09-13T17:00:00.000Z',
  });
  deliveries.push(delivery);
  return { delivery, post, report, raised, store };
}
const eventId = (alert: JournalAlert) => alert.labels.engine_alert_event_id;

describe('durable engine alert delivery', () => {
  it('preserves every F/R/F transition offline, even within the same millisecond', async () => {
    const { delivery, store, post, raised } = setup();
    await delivery.raise(input);
    await delivery.raise(input);
    await delivery.resolve(input.alertname, input.component, 'Recovered');
    await delivery.raise({ ...input, page: true });
    expect(store.state.pending.map((event) => event.alert.status)).toEqual([
      'firing',
      'resolved',
      'firing',
    ]);
    const alerts = store.state.pending.map((event) => event.alert);
    expect(new Set(alerts.map(eventId)).size).toBe(3);
    expect(alerts[0].labels.engine_alert_episode_id).toBe(alerts[1].labels.engine_alert_episode_id);
    expect(alerts[2].labels.engine_alert_episode_id).not.toBe(
      alerts[0].labels.engine_alert_episode_id
    );
    expect(alerts[2].labels.engine_alert_priority).toBe('page');
    expect(raised).toHaveBeenCalledTimes(2);
    post.mockClear().mockResolvedValue(true);
    await delivery.sendOne();
    await delivery.sendOne();
    await delivery.sendOne();
    expect(post.mock.calls.map(([alert]) => alert.status)).toEqual([
      'firing',
      'resolved',
      'firing',
    ]);
    expect(store.state.pending).toEqual([]);
    expect(delivery.snapshot().firing).toEqual(['FleetStopped:horses']);
  });

  it('persists concurrent recovery and recurrence while the firing HTTP request is still blocked', async () => {
    const { delivery, store, post } = setup();
    let release!: (value: boolean) => void;
    let persisted!: () => void;
    let started!: () => void;
    const pending = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const durable = new Promise<void>((resolve) => {
      persisted = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const save = store.save.bind(store);
    store.save = async (state) => {
      await save(state);
      if (state.pending.length === 3) persisted();
    };
    post.mockImplementation(() => {
      started();
      return pending;
    });
    const first = delivery.raise(input);
    await entered;
    const calls = [
      first,
      delivery.raise(input),
      delivery.resolve(input.alertname, input.component, 'Recovered'),
      delivery.raise(input),
    ];
    await durable;
    expect(store.state.pending.map((event) => event.alert.status)).toEqual([
      'firing',
      'resolved',
      'firing',
    ]);
    expect(post).toHaveBeenCalledTimes(1);
    release(true);
    await Promise.all(calls);
    post.mockResolvedValue(true);
    await delivery.sendOne();
    await delivery.sendOne();
    expect(post.mock.calls.map(([alert]) => alert.status)).toEqual([
      'firing',
      'resolved',
      'firing',
    ]);
  });

  it('retains observations across persistence failure and never sends unpersisted evidence', async () => {
    const { delivery, store, post, report } = setup();
    let fail = true;
    const save = store.save.bind(store);
    store.save = async (state) => {
      if (fail) throw new Error('disk unavailable');
      await save(state);
    };
    await expect(delivery.raise(input)).resolves.toBe(false);
    await expect(delivery.resolve(input.alertname, input.component, 'Recovered')).resolves.toBe(
      false
    );
    expect(post).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(delivery.snapshot()).toMatchObject({ dirty: true, pending: 2 });
    fail = false;
    post.mockResolvedValue(true);
    await delivery.sendOne();
    await delivery.sendOne();
    expect(post.mock.calls.map(([alert]) => alert.status)).toEqual(['firing', 'resolved']);
    expect(store.state.pending).toEqual([]);
  });

  it('retains queued observations while loading the checkpoint is temporarily unavailable', async () => {
    const { delivery, store, post } = setup();
    let fail = true;
    const load = store.load.bind(store);
    store.load = async () => {
      if (fail) throw new Error('checkpoint unreadable');
      return load();
    };
    await delivery.raise(input);
    await delivery.resolve(input.alertname, input.component, 'Recovered');
    expect(delivery.snapshot().unpersistedObservations).toBe(2);
    expect(post).not.toHaveBeenCalled();
    fail = false;
    post.mockResolvedValue(true);
    await delivery.sendOne();
    await delivery.sendOne();
    expect(post.mock.calls.map(([alert]) => alert.status)).toEqual(['firing', 'resolved']);
  });

  it('clears a recovered storage error even when healthy observations produced no event', async () => {
    const { delivery, store } = setup();
    let readable = false;
    const load = store.load.bind(store);
    store.load = async () => {
      if (!readable) throw new Error('EIO');
      return load();
    };
    await delivery.resolve(input.alertname, input.component, 'Already healthy');
    expect(delivery.snapshot().error).toBe('EIO');
    readable = true;
    await delivery.sendOne();
    expect(delivery.snapshot()).toMatchObject({
      loaded: true,
      pending: 0,
      unpersistedObservations: 0,
      error: null,
    });
  });

  it('preserves observation times across an unreadable checkpoint and reports queue freshness', async () => {
    const store = new MemoryAlertJournal(emptyAlertJournal());
    let readable = false;
    const load = store.load.bind(store);
    store.load = async () => {
      if (!readable) throw new Error('EIO');
      return load();
    };
    let now = '2026-09-13T17:00:00.000Z';
    const post = vi.fn().mockResolvedValue(false);
    const delivery = new EngineAlertDelivery({
      store,
      automatic: false,
      post,
      report: vi.fn(),
      now: () => now,
    });
    deliveries.push(delivery);
    await delivery.raise(input);
    now = '2026-09-13T17:01:00.000Z';
    await delivery.resolve(input.alertname, input.component, 'Recovered');
    now = '2026-09-13T17:02:00.000Z';
    await delivery.raise(input);
    readable = true;
    now = '2026-09-13T17:05:00.000Z';
    await delivery.sendOne();
    expect(store.state.pending.map(({ alert }) => [alert.startsAt, alert.endsAt])).toEqual([
      ['2026-09-13T17:00:00.000Z', undefined],
      ['2026-09-13T17:00:00.000Z', '2026-09-13T17:01:00.000Z'],
      ['2026-09-13T17:02:00.000Z', undefined],
    ]);
    expect(delivery.snapshot()).toMatchObject({
      pending: 3,
      oldestPendingAt: '2026-09-13T17:00:00.000Z',
      lastAttemptAt: now,
      lastAcknowledgedAt: null,
    });
    post.mockResolvedValue(true);
    await delivery.sendOne();
    expect(delivery.snapshot()).toMatchObject({
      pending: 2,
      oldestPendingAt: '2026-09-13T17:01:00.000Z',
      lastAcknowledgedAt: now,
    });
  });

  it('reuses the immutable event identity after a lost HTTP response and process restart', async () => {
    const store = new MemoryAlertJournal(emptyAlertJournal());
    const received = new Map<string, JournalAlert>();
    const first = setup(store);
    first.post.mockImplementation(async (alert) => {
      received.set(eventId(alert), structuredClone(alert));
      throw new Error('response lost');
    });
    await first.delivery.raise(input);
    const persisted = structuredClone(store.state.pending[0].alert);
    first.delivery.stop();
    const second = setup(store);
    second.post.mockImplementation(async (alert) => {
      received.set(eventId(alert), structuredClone(alert));
      return true;
    });
    await second.delivery.sendOne();
    expect(second.post).toHaveBeenCalledWith(persisted);
    expect(received.size).toBe(1);
    expect(store.state.pending).toEqual([]);
    await second.delivery.resolve(input.alertname, input.component, 'Recovered');
    expect(second.post.mock.calls[1][0].startsAt).toBe(persisted.startsAt);
    expect(second.post.mock.calls[1][0].labels.engine_alert_episode_id).toBe(
      persisted.labels.engine_alert_episode_id
    );
  });

  it('retries the same event if removing its acknowledged checkpoint fails', async () => {
    const { delivery, store, post } = setup();
    const save = store.save.bind(store);
    store.save = async (state: AlertJournalState) => {
      if (!state.pending.length) throw new Error('ack checkpoint failed');
      await save(state);
    };
    post.mockResolvedValue(true);
    await expect(delivery.raise(input)).resolves.toBe(false);
    const pending = store.state.pending[0].alert;
    store.save = save;
    await delivery.sendOne();
    expect(post).toHaveBeenNthCalledWith(1, pending);
    expect(post).toHaveBeenNthCalledWith(2, pending);
    expect(store.state.pending).toEqual([]);
  });

  it('drains restored pending events without another producer call', async () => {
    const store = new MemoryAlertJournal(emptyAlertJournal());
    const first = setup(store);
    await first.delivery.raise(input);
    first.delivery.stop();
    let acknowledged!: () => void;
    const done = new Promise<void>((resolve) => {
      acknowledged = resolve;
    });
    const save = store.save.bind(store);
    store.save = async (state) => {
      await save(state);
      if (!state.pending.length) acknowledged();
    };
    const second = setup(store, true);
    second.post.mockResolvedValue(true);
    await done;
    expect(second.post).toHaveBeenCalledTimes(1);
    expect(store.state.active).toHaveLength(1);
  });

  it('settles the journal for shutdown without waiting on an in-flight network send', async () => {
    const { delivery, store, post } = setup();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    post.mockImplementation(() => {
      started();
      return new Promise<boolean>(() => {});
    });
    void delivery.raise(input);
    await entered;
    await expect(delivery.persistBeforeExit()).resolves.toBe(true);
    expect(store.state.pending).toHaveLength(1);
    expect(store.state.active).toHaveLength(1);
  });
});
