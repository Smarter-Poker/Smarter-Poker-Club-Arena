/** Table lifecycle must not hold an audio device or run empty keepalive pings. */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useTabKeepAlive,
  workerTimeout,
  cancelWorkerTimeout,
} from '../../src/hooks/useTabKeepAlive';

let worker: {
  onmessage: ((e: { data: { id: number } }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};
let createWorker: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  createWorker = vi.fn(function () {
    worker = { onmessage: null, postMessage: vi.fn(), terminate: vi.fn() };
    return worker;
  });
  vi.stubGlobal('Worker', createWorker);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:decision');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bounded table decision timers', () => {
  it('does no idle work, including across four-table churn', () => {
    const audio = vi.fn();
    vi.stubGlobal('AudioContext', audio);
    for (let i = 0; i < 10; i++) {
      const tables = Array.from({ length: 4 }, () => renderHook(() => useTabKeepAlive()));
      act(() => vi.advanceTimersByTime(60_000));
      expect(audio).not.toHaveBeenCalled();
      expect(createWorker).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      tables.forEach((table) => table.unmount());
    }
  });

  it('retains the real insurance deadline while another table leaves, then releases the worker', () => {
    const a = renderHook(() => useTabKeepAlive());
    const b = renderHook(() => useTabKeepAlive());
    const decline = vi.fn();
    const id = workerTimeout(decline, 12_500);
    expect(worker.postMessage).toHaveBeenCalledWith({ id, ms: 12_500 });
    a.unmount();
    expect(worker.terminate).not.toHaveBeenCalled();
    act(() => worker.onmessage?.({ data: { id } }));
    expect(decline).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    b.unmount();
  });

  it('a cancelled decision never fires and leaves no worker behind', () => {
    const table = renderHook(() => useTabKeepAlive());
    const decline = vi.fn();
    const id = workerTimeout(decline, 15_000);
    const deliver = worker.onmessage;
    cancelWorkerTimeout(id);
    deliver?.({ data: { id } });
    expect(decline).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    table.unmount();
  });

  it('clears the ordinary timeout fallback when the last table leaves', () => {
    createWorker.mockImplementationOnce(() => {
      throw new Error('Worker unavailable');
    });
    const table = renderHook(() => useTabKeepAlive());
    const decline = vi.fn();
    workerTimeout(decline, 15_000);
    expect(vi.getTimerCount()).toBe(1);
    table.unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(20_000));
    expect(decline).not.toHaveBeenCalled();
  });
});
