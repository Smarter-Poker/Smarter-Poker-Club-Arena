import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { HistoryJoinObservation, observeHistoryJoin } from '../e2e/support/historyJoinObservation';
const topic = 'realtime:player-history:club';
const frame = (event: string, ref = '1', status = 'ok', otherTopic = topic) =>
  JSON.stringify([null, ref, otherTopic, event, { status, access_token: 'must-not-be-retained' }]);
afterEach(() => vi.useRealTimers());
describe('private history join qualification', () => {
  it('exposes the old 15s false failure while admitting a valid 18s setup and 1s join', async () => {
    vi.useFakeTimers();
    const observation = new HistoryJoinObservation();
    observation.begin(0);
    let now = 0;
    const result = observation.wait(topic, () => now);
    now = 15000;
    await vi.advanceTimersByTimeAsync(15000);
    expect(observation.result(topic, now).phase).toBe('waiting_admission');
    // The previous spec's sole 15s predicate is false at its deadline.
    expect(observation.result(topic, now).phase === 'joined').toBe(false);
    now = 18000;
    observation.record('sent', frame('phx_join'), now);
    now = 19000;
    observation.record('received', frame('phx_reply'), now);
    await expect(result).resolves.toBeUndefined();
    expect(observation.result(topic, now)).toMatchObject({
      phase: 'joined',
      admissionMs: 18000,
      joinMs: 1000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails no-join at the admission deadline instead of granting all 80s', async () => {
    vi.useFakeTimers();
    let now = 0;
    const observation = new HistoryJoinObservation();
    observation.begin(now);
    const pending = observation.wait(topic, () => now);
    const refusal = expect(pending).rejects.toThrow('admission_timeout');
    now = 20000;
    await vi.advanceTimersByTimeAsync(20000);
    await refusal;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the current 60s page join bound and never resets it for retries', async () => {
    vi.useFakeTimers();
    let now = 0;
    const observation = new HistoryJoinObservation();
    observation.begin(now);
    now = 20000;
    observation.record('sent', frame('phx_join'), now);
    const pending = observation.wait(topic, () => now);
    const refusal = expect(pending).rejects.toThrow('join_timeout');
    now = 30000;
    observation.record('sent', frame('phx_join', '2'), now);
    now = 80000;
    await vi.advanceTimersByTimeAsync(60000);
    await refusal;
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['wrong-ref', 'wrong-topic', 'access-token', 'error'])(
    'does not treat %s as a join acknowledgment',
    (kind) => {
      const o = new HistoryJoinObservation();
      o.begin(0);
      o.record('sent', frame('phx_join'), 1000);
      if (kind === 'access-token') o.record('sent', frame('access_token', '2'), 1001);
      o.record(
        'received',
        frame(
          'phx_reply',
          kind === 'wrong-ref' || kind === 'access-token' ? '2' : '1',
          kind === 'error' ? 'error' : 'ok',
          kind === 'wrong-topic' ? `${topic}-other` : topic
        ),
        2000
      );
      expect(o.result(topic, 2000).phase).toBe('waiting_join_ack');
    }
  );
  it('accepts object frames and correlated retry acknowledgment inside the first join deadline', () => {
    const o = new HistoryJoinObservation();
    o.begin(0);
    o.record('sent', JSON.stringify({ topic, event: 'phx_join', ref: 'join' }), 1000);
    o.record('sent', JSON.stringify({ topic, event: 'phx_join', ref: 'retry' }), 11000);
    o.record(
      'received',
      JSON.stringify({ topic, event: 'phx_reply', ref: 'retry', payload: { status: 'ok' } }),
      15000
    );
    expect(o.result(topic, 15000).phase).toBe('joined');
  });
  it('accepts a delayed 33.6s acknowledgment inside the current page contract', () => {
    const o = new HistoryJoinObservation();
    o.begin(0);
    o.record('sent', frame('phx_join'), 18000);
    o.record('received', frame('phx_reply'), 51600);
    expect(o.result(topic, 51600)).toMatchObject({
      phase: 'joined',
      admissionMs: 18000,
      joinMs: 33600,
    });
  });
  it('rejects stale earlier generation and other physical socket replies', () => {
    const o = new HistoryJoinObservation();
    const firstSocket = {};
    const otherSocket = {};
    o.begin(0);
    o.record('sent', frame('phx_join', 'old'), 1000, firstSocket);
    o.record('sent', frame('phx_join', 'current'), 2000, firstSocket);
    o.record('received', frame('phx_reply', 'old'), 3000, firstSocket);
    expect(o.result(topic, 3000).phase).toBe('waiting_join_ack');
    o.record('received', frame('phx_reply', 'current'), 4000, otherSocket);
    expect(o.result(topic, 4000).phase).toBe('waiting_join_ack');
    o.record('received', frame('phx_reply', 'current'), 5000, firstSocket);
    expect(o.result(topic, 5000)).toMatchObject({
      phase: 'joined',
      admissionMs: 1000,
      joinMs: 4000,
    });
  });
  it('does not spend admission on a 10s RPC before an 18s admission and 10s ACK', async () => {
    vi.useFakeTimers();
    const o = new HistoryJoinObservation();
    let now = 0;
    let read!: (topic: string) => void;
    const pending = o.qualify(
      () =>
        new Promise<string>((resolve) => {
          read = resolve;
        }),
      () => now
    );
    // Keep the expected before-fix rejection observed while the fake clock advances.
    void pending.catch(() => undefined);
    now = 10000;
    await vi.advanceTimersByTimeAsync(10000);
    read(topic);
    await Promise.resolve();
    await Promise.resolve();
    now = 28000;
    await vi.advanceTimersByTimeAsync(18000);
    o.record('sent', frame('phx_join'), now);
    now = 38000;
    await vi.advanceTimersByTimeAsync(10000);
    o.record('received', frame('phx_reply'), now);
    await expect(pending).resolves.toBeUndefined();
    expect(o.result(topic, now)).toMatchObject({
      phase: 'joined',
      admissionMs: 18000,
      joinMs: 10000,
      elapsedMs: 28000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves an early real join and ACK during scope-body decoding', async () => {
    const o = new HistoryJoinObservation();
    let now = 0;
    await o.qualify(
      async () => {
        o.record('sent', frame('phx_join'), 10);
        o.record('received', frame('phx_reply'), 20);
        now = 30;
        return topic;
      },
      () => now
    );
    expect(o.result(topic, now)).toMatchObject({ phase: 'joined', admissionMs: 0, joinMs: 10 });
  });
  it('leaves a never-resolving HTTP read to the existing caller budget and permits cancellation', async () => {
    vi.useFakeTimers();
    const o = new HistoryJoinObservation();
    let now = 0;
    const pending = o.qualify(
      () => new Promise<string>(() => undefined),
      () => now
    );
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    now = 35000;
    await vi.advanceTimersByTimeAsync(35000);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const refusal = expect(pending).rejects.toThrow('disposed');
    o.dispose();
    await refusal;
  });
  it('refuses late admission and late acknowledgment, even if read afterward', () => {
    const a = new HistoryJoinObservation();
    a.begin(0);
    a.record('sent', frame('phx_join'), 20001);
    a.record('received', frame('phx_reply'), 20002);
    expect(a.result(topic, 20002).phase).toBe('admission_timeout');
    const b = new HistoryJoinObservation();
    b.begin(0);
    b.record('sent', frame('phx_join'), 1000);
    b.record('received', frame('phx_reply'), 61001);
    expect(b.result(topic, 61001).phase).toBe('join_timeout');
  });
  it('ignores stale pre-disclosure frames and keeps diagnostics free of topics, refs and payloads', () => {
    const o = new HistoryJoinObservation();
    o.record('sent', frame('phx_join'), 0);
    o.begin(10);
    o.record('received', frame('phx_reply'), 11);
    const diagnostic = JSON.stringify(o.result(topic, 12));
    expect(diagnostic).not.toMatch(/must-not-be-retained|player-history|access_token|"ref"/);
    expect(o.result(topic, 12).phase).toBe('waiting_admission');
  });
  it('removes socket/page listeners and rejects a pending waiter on cleanup', async () => {
    vi.useFakeTimers();
    const page = new EventEmitter();
    const socket = new EventEmitter();
    const handle = observeHistoryJoin(page as any);
    page.emit('websocket', socket);
    handle.observation.begin(0);
    const pending = handle.observation.wait(topic, () => 0);
    const refusal = expect(pending).rejects.toThrow('disposed');
    handle.dispose();
    await refusal;
    expect(socket.listenerCount('framesent')).toBe(0);
    expect(socket.listenerCount('framereceived')).toBe(0);
    expect(page.listenerCount('websocket')).toBe(0);
    expect(page.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
