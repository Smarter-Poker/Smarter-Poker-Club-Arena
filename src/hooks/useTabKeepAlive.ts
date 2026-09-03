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
import { reportError } from '../utils/errorReporter';

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
    const url = URL.createObjectURL(blob);
    _timerWorker = new Worker(url);
    URL.revokeObjectURL(url); // Worker holds its own handle once constructed
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
  } catch (e) {
    reportError(e, 'useTabKeepAlive.workerTimeout');
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

// ─── Shared keepalive resources (refcounted singletons) ──────────────────────
//
// ANIMATION/SOUND AUDIT 2026-08-20 — AUDIO EXHAUSTION FIX.
//
// This hook used to build a PER-MOUNT AudioContext and a PER-MOUNT Worker.
// MultiTablePage keeps up to MAX_TABLES (4) TablePage instances mounted
// SIMULTANEOUSLY — by design, so every EngineStateClient socket stays live —
// so four tables meant four keepalive contexts. Add the SoundService context
// (constructed at module import, so it always exists), the PremiumSFX context,
// and a VoiceRecorder context, and a 4-table session reaches SEVEN concurrent
// AudioContexts against Chrome's hard cap of SIX per document. The seventh
// throws on construction, and because SoundService/PremiumSFX build theirs
// LAZILY they are the ones that lose the race — the failure mode is the whole
// table going SILENT, which is precisely the outcome the animation/sound work
// exists to prevent.
//
// The keepalive context's job is "keep THIS TAB unthrottled". That is a
// per-DOCUMENT concern, not a per-table one: four of them do nothing that one
// does. Both resources are now refcounted module singletons — the first mount
// creates, the last unmount tears down. Ceiling drops 7 -> 4, permanently
// clear of the cap.
//
// The blob URLs are revoked immediately after construction (the Worker keeps
// its own handle once created); previously each table open leaked one for the
// lifetime of the document.

let _keepAliveRefs = 0;
let _keepAliveCtx: AudioContext | null = null;
let _keepAliveWorker: Worker | null = null;

function acquireKeepAlive(): void {
  _keepAliveRefs += 1;
  if (_keepAliveRefs > 1) return; // already running — just count the new holder

  // 1. Web Worker keepalive — pings every 3 seconds from a worker thread
  try {
    const blob = new Blob(['setInterval(function(){postMessage("k")},3000)'], {
      type: 'application/javascript',
    });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = () => {
      (window as any).__keepAliveTs = Date.now();
    };
    _keepAliveWorker = worker;
  } catch (e) {
    console.warn('[KeepAlive] Web Worker failed:', e);
  }

  // 2. Silent AudioContext — Chrome won't throttle tabs playing audio
  try {
    _keepAliveCtx = new AudioContext();
    const osc = _keepAliveCtx.createOscillator();
    const gain = _keepAliveCtx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(_keepAliveCtx.destination);
    osc.start();
  } catch (e) {
    // Non-fatal by design: if we are already at the cap the tab simply keeps
    // its Worker-based throttle protection, which covers horse think-timers.
    _keepAliveCtx = null;
    console.warn('[KeepAlive] AudioContext failed:', e);
  }
}

function releaseKeepAlive(): void {
  _keepAliveRefs = Math.max(0, _keepAliveRefs - 1);
  if (_keepAliveRefs > 0) return; // another table is still holding it open

  if (_keepAliveWorker) {
    _keepAliveWorker.terminate();
    _keepAliveWorker = null;
  }
  if (_keepAliveCtx) {
    _keepAliveCtx
      .close()
      .catch((e) => console.warn('[KeepAlive] Failed to close AudioContext:', e));
    _keepAliveCtx = null;
  }
}

/** Test-only: current refcount + whether the shared resources are live. */
export function __keepAliveDebugState(): {
  refs: number;
  hasCtx: boolean;
  hasWorker: boolean;
} {
  return {
    refs: _keepAliveRefs,
    hasCtx: _keepAliveCtx !== null,
    hasWorker: _keepAliveWorker !== null,
  };
}

export function useTabKeepAlive(): void {
  const heldRef = useRef(false);

  useEffect(() => {
    // StrictMode double-invoke and re-render safety: never acquire twice for
    // the same mount, or the refcount would never fall back to zero.
    if (heldRef.current) return;
    heldRef.current = true;

    acquireKeepAlive();

    // Pre-warm the timer worker so the first horse decision doesn't lag.
    // Already a module singleton, so this is idempotent across tables.
    try {
      getTimerWorker();
    } catch (e) {
      reportError(e, 'useTabKeepAlive.onmessage');
      /* ok */
    }

    console.debug(`[KeepAlive] Tab keepalive active (shared, refs=${_keepAliveRefs})`);

    return () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      releaseKeepAlive();
      console.debug(`[KeepAlive] Tab keepalive released (refs=${_keepAliveRefs})`);
    };
  }, []);
}
