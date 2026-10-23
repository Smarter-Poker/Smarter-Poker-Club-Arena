/**
 * Bounded table decision timers. The historical hook name is retained for its
 * TablePage caller; it now owns cleanup only, never anti-throttling activity.
 * Real sounds and screen wake locks have separate owners.
 */
import { useEffect } from 'react';
import { reportError } from '../utils/errorReporter';

// A worker is useful only while an insurance decision is actually pending.
// Browser/OS suspension can still delay delivery; the engine owns the deadline.
let _timerWorker: Worker | null = null;
let _timerId = 0;
const _callbacks = new Map<number, () => void>();
const fallbackTimers = new Map<number, ReturnType<typeof setTimeout>>();

function releaseIdleWorker(): void {
  if (_callbacks.size > 0) return;
  _timerWorker?.terminate();
  _timerWorker = null;
}

function finishTimer(id: number): void {
  const callback = _callbacks.get(id);
  _callbacks.delete(id);
  clearTimeout(fallbackTimers.get(id));
  fallbackTimers.delete(id);
  releaseIdleWorker();
  callback?.();
}

function getTimerWorker(): Worker {
  if (_timerWorker) return _timerWorker;
  const code = `
    const timers = new Map();
    self.onmessage = function(e) {
      const { id, ms, cancel } = e.data;
      if (cancel) {
        clearTimeout(timers.get(id));
        timers.delete(id);
        return;
      }
      timers.set(id, setTimeout(function() {
        timers.delete(id);
        postMessage({ id });
      }, ms));
    };
  `;
  const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
  try {
    const worker = new Worker(url);
    worker.onmessage = (event: MessageEvent<{ id: number }>) => {
      if (_timerWorker === worker) finishTimer(event.data.id);
    };
    _timerWorker = worker;
    return worker;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Schedule one decision deadline without a continuously running keepalive. */
export function workerTimeout(fn: () => void, ms: number): number {
  const id = ++_timerId;
  _callbacks.set(id, fn);
  try {
    getTimerWorker().postMessage({ id, ms });
  } catch (error) {
    reportError(error, 'useTabKeepAlive.workerTimeout');
    fallbackTimers.set(
      id,
      setTimeout(() => finishTimer(id), ms)
    );
  }
  return id;
}

export function cancelWorkerTimeout(id: number): void {
  if (!_callbacks.delete(id)) return;
  clearTimeout(fallbackTimers.get(id));
  fallbackTimers.delete(id);
  try {
    _timerWorker?.postMessage({ id, cancel: true });
  } catch (error) {
    reportError(error, 'useTabKeepAlive.cancelWorkerTimeout');
  } finally {
    releaseIdleWorker();
  }
}

/**
 * Tables own pending decision timers, not a permanently active audio device.
 * Horse decisions run on the server. A silent oscillator and empty worker
 * pings cannot help that server and keep a phone doing work for the whole
 * session. The timer worker above is created only for a real decision.
 */
let timerHolders = 0;

export function useTabKeepAlive(): void {
  useEffect(() => {
    timerHolders += 1;
    return () => {
      timerHolders -= 1;
      if (timerHolders > 0) return;
      // The last table has left. No decision callback may outlive its owner.
      for (const timer of fallbackTimers.values()) clearTimeout(timer);
      fallbackTimers.clear();
      _callbacks.clear();
      _timerWorker?.terminate();
      _timerWorker = null;
    };
  }, []);
}
