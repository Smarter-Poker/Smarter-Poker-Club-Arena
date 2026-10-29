import { describe, it, expect, vi } from 'vitest';
import {
  createV31WorkerControl,
  V31ControlClient,
  v31ControlRequestValid,
  type V31ControlRequest,
  type V31ControlAck,
} from './v31ReloadControl.js';
const id = {
  requestId: '12345678-1234-4234-8234-123456789abc',
  datasetId: '12345678-1234-4234-8234-123456789abd',
  checksum: 'a'.repeat(64),
};
const request: V31ControlRequest = {
  type: 'V31_STORE_CONTROL',
  operation: 'reload',
  ...id,
  expectedCells: 107,
};
const snapshot = () => ({ count: 107, dataset: { id: id.datasetId, checksum: id.checksum } });
describe('explicit V31 worker control', () => {
  it('keeps asynchronous loading separate from decision dispatch and joins duplicate owners', async () => {
    let finish!: (n: { ok: boolean; count: number }) => void;
    const load = vi.fn(
        () =>
          new Promise<{ ok: boolean; count: number }>((resolve) => {
            finish = resolve;
          })
      ),
      send = vi.fn();
    const control = createV31WorkerControl({ load, snapshot, send });
    expect(control(request)).toBe(true);
    let decision = 0;
    if (!control({ type: 'DECIDE_FAST' })) decision++;
    expect(decision).toBe(1);
    expect(send).not.toHaveBeenCalled();
    control(request);
    expect(load).toHaveBeenCalledTimes(1);
    finish({ ok: true, count: 107 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[0][0].ok).toBe(true);
  });
  it('reports retained old identity as failure without clearing the snapshot', async () => {
    const send = vi.fn(),
      old = { count: 99, dataset: { id: id.datasetId, checksum: 'b'.repeat(64) } };
    createV31WorkerControl({
      load: async () => ({ ok: false, count: 0 }),
      snapshot: () => old,
      send,
    })(request);
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(send.mock.calls[0][0]).toMatchObject({ ok: false, count: 99, dataset: old.dataset });
  });
  it('reads status without invoking load; rejects malformed wire keys', async () => {
    const load = vi.fn(),
      send = vi.fn(),
      control = createV31WorkerControl({ load, snapshot, send });
    control({ ...request, operation: 'status' });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(load).not.toHaveBeenCalled();
    expect(v31ControlRequestValid({ ...request, rows: [] })).toBe(false);
  });
  it('uses a separate bounded deadline and ignores a late ack without terminating a decision worker', async () => {
    vi.useFakeTimers();
    try {
      const post = vi.fn(),
        client = new V31ControlClient(post, 100),
        p = client.request(request),
        failure = expect(p).rejects.toThrow('outcome_unknown');
      await vi.advanceTimersByTimeAsync(100);
      await failure;
      expect(post).toHaveBeenCalledTimes(1);
      expect(
        client.receive({
          type: 'V31_STORE_CONTROL_ACK',
          operation: 'reload',
          requestId: id.requestId,
          ok: true,
          ...snapshot(),
          error: null,
        } satisfies V31ControlAck)
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
  it('status on the same request identity reads current state after a completed reload', async () => {
    let actual = { count: 0, dataset: null as any };
    const send = vi.fn(),
      control = createV31WorkerControl({
        load: async () => ({ ok: true, count: 107 }),
        snapshot: () => actual,
        send,
      });
    control({ ...request, operation: 'status' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0][0].ok).toBe(false);
    actual = snapshot();
    control({ ...request, operation: 'status' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1][0].ok).toBe(true);
  });
  it('rejects a successful control acknowledgment for another corpus without changing decision state', async () => {
    const client = new V31ControlClient(() => {}),
      pending = client.request(request),
      failure = expect(pending).rejects.toThrow('ack_binding_mismatch');
    client.receive({
      type: 'V31_STORE_CONTROL_ACK',
      operation: 'reload',
      requestId: id.requestId,
      ok: true,
      count: 107,
      dataset: { id: id.datasetId, checksum: 'b'.repeat(64) },
      error: null,
    });
    await failure;
  });

  it('reports a stopped or failed worker immediately without starting a replacement', async () => {
    const post = vi.fn(),
      client = new V31ControlClient(post),
      pending = client.request(request),
      failure = expect(pending).rejects.toThrow('worker_stopping');
    client.close(Error('worker_stopping'));
    await failure;
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('contains failed owner and duplicate ACK delivery; repaired same-ID status never reloads', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}),
      unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let broken = true;
      const load = vi.fn(async () => ({ ok: true, count: 107 }));
      const send = vi.fn((_ack: V31ControlAck) => {
        if (broken) throw Error('private send detail');
      });
      const control = createV31WorkerControl({ load, snapshot, send });
      control(request);
      control(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(2);
      expect(load).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls).toEqual([['V31_STORE_CONTROL_ACK_UNCONFIRMED', id.requestId]]);
      broken = false;
      control({ ...request, operation: 'status' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send.mock.calls.at(-1)?.[0]).toMatchObject({
        operation: 'status',
        requestId: id.requestId,
        ok: true,
        ...snapshot(),
        error: null,
      });
      control(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'reload', ok: true });
      expect(load).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      warning.mockRestore();
    }
  });
  it('contains rejected owner and duplicate snapshots without fabricating a reload result', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {}),
      unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      let broken = true;
      const load = vi.fn(async () => ({ ok: true, count: 107 })),
        send = vi.fn();
      const read = () => {
        if (broken) throw Error('private snapshot detail');
        return snapshot();
      };
      const control = createV31WorkerControl({ load, snapshot: read, send });
      control(request);
      control(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
      expect(warning.mock.calls).toEqual([['V31_STORE_CONTROL_ACK_UNCONFIRMED', id.requestId]]);
      broken = false;
      control({ ...request, operation: 'status' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toMatchObject({ operation: 'status', ok: true, ...snapshot() });
      control(request);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(1);
      expect(load).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', unhandled);
      warning.mockRestore();
    }
  });
  it('settles rejected status so a fresh same-ID read can observe the repaired snapshot', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let broken = true;
      const load = vi.fn(),
        send = vi.fn();
      const control = createV31WorkerControl({
        load,
        send,
        snapshot: () => {
          if (broken) throw Error('private state');
          return snapshot();
        },
      });
      control({ ...request, operation: 'status' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).not.toHaveBeenCalled();
      broken = false;
      control({ ...request, operation: 'status' });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0]).toMatchObject({ operation: 'status', ok: true });
      expect(load).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  });
  it('contains synchronous snapshot/send failures on conflict and reload-busy ACKs', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let finish!: (r: { ok: boolean; count: number }) => void,
        badSnapshot = true,
        badSend = true;
      const load = vi.fn(
        () =>
          new Promise<{ ok: boolean; count: number }>((resolve) => {
            finish = resolve;
          })
      );
      const send = vi.fn((_ack: V31ControlAck) => {
        if (badSend) throw Error('private sender');
      });
      const control = createV31WorkerControl({
        load,
        send,
        snapshot: () => {
          if (badSnapshot) throw Error('private snapshot');
          return snapshot();
        },
      });
      const conflict = { ...request, checksum: 'b'.repeat(64) },
        busy = { ...request, requestId: '12345678-1234-4234-8234-123456789abe' };
      control(request);
      expect(() => control(conflict)).not.toThrow();
      expect(() => control(busy)).not.toThrow();
      badSnapshot = false;
      expect(() => control(conflict)).not.toThrow();
      expect(() => control(busy)).not.toThrow();
      badSend = false;
      finish({ ok: true, count: 107 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(load).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls).toEqual([
        ['V31_STORE_CONTROL_ACK_UNCONFIRMED', id.requestId],
        ['V31_STORE_CONTROL_ACK_UNCONFIRMED', busy.requestId],
      ]);
      expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'reload', ok: true });
    } finally {
      warning.mockRestore();
    }
  });
});
