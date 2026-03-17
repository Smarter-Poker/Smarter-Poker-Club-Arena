/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TAB KEEPALIVE HOOK — Prevents Chrome from throttling background tabs
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Chrome aggressively throttles setTimeout/setInterval in background tabs,
 * stretching timers to ~1 minute intervals. This kills horse decision-making
 * which relies on setTimeout(thinkTime).
 *
 * Two techniques used together:
 * 1. Web Worker — runs in a separate thread, not subject to tab throttling
 * 2. Silent AudioContext — playing audio (even silent) keeps the tab active
 *
 * Also exports workerTimeout() — a throttle-proof setTimeout replacement
 * that uses a Web Worker for timing instead of the main thread timer.
 */

import { useEffect, useRef } from 'react';

// ─── Worker-based setTimeout (throttle-proof) ────────────────────────────────
// Chrome can't throttle Web Worker timers, so we route timing through a worker.

let _timerWorker: Worker | null = null;
let _timerId = 0;
const _callbacks = new Map<number, () => void>();

function getTimerWorker(): Worker {
  if (!_timerWorker) {
    const code = `
            self.onmessage = function(e) {
                var id = e.data.id;
                var ms = e.data.ms;
                setTimeout(function() { postMessage({ id: id }); }, ms);
            };
        `;
    const blob = new Blob([code], { type: 'application/javascript' });
    _timerWorker = new Worker(URL.createObjectURL(blob));
    _timerWorker.onmessage = (e: MessageEvent) => {
      const cb = _callbacks.get(e.data.id);
      if (cb) {
        _callbacks.delete(e.data.id);
        cb();
      }
    };
  }
  return _timerWorker;
}

/**
 * Throttle-proof setTimeout — uses a Web Worker for timing.
 * Drop-in replacement for setTimeout(fn, ms).
 * Returns an id that can be passed to cancelWorkerTimeout().
 */
export function workerTimeout(fn: () => void, ms: number): number {
  const id = ++_timerId;
  _callbacks.set(id, fn);
  try {
    getTimerWorker().postMessage({ id, ms });
  } catch {
    // Fallback to regular setTimeout if Worker fails
    setTimeout(() => {
      const cb = _callbacks.get(id);
      if (cb) {
        _callbacks.delete(id);
        cb();
      }
    }, ms);
  }
  return id;
}

/**
 * Cancel a pending workerTimeout by id.
 * Prevents memory leaks from accumulated closures when hands complete
 * before think-time timers fire.
 */
export function cancelWorkerTimeout(id: number): void {
  _callbacks.delete(id);
}

// ─── React Hook ──────────────────────────────────────────────────────────────

export function useTabKeepAlive(): void {
  const workerRef = useRef<Worker | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    // 1. Web Worker keepalive — pings every 3 seconds from a worker thread
    try {
      const blob = new Blob(['setInterval(function(){postMessage("k")},3000)'], {
        type: 'application/javascript',
      });
      const worker = new Worker(URL.createObjectURL(blob));
      worker.onmessage = () => {
        (window as any).__keepAliveTs = Date.now();
      };
      workerRef.current = worker;
    } catch (e) {
      console.warn('[KeepAlive] Web Worker failed:', e);
    }

    // 2. Silent AudioContext — Chrome won't throttle tabs playing audio
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      audioCtxRef.current = ctx;
    } catch (e) {
      console.warn('[KeepAlive] AudioContext failed:', e);
    }

    // 3. Pre-warm the timer worker so first horse decision doesn't lag
    try {
      getTimerWorker();
    } catch {
      /* ok */
    }

    console.log('[KeepAlive] Tab keepalive active (Worker + AudioContext + WorkerTimeout)');

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
        workerRef.current = null;
      }
      if (audioCtxRef.current) {
        audioCtxRef.current
          .close()
          .catch((e) => console.warn('[KeepAlive] Failed to close AudioContext:', e));
        audioCtxRef.current = null;
      }
      console.log('[KeepAlive] Tab keepalive stopped');
    };
  }, []);
}
