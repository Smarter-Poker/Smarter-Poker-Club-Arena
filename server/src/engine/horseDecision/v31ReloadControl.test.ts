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
});
