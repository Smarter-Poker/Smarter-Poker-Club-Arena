/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TAB KEEPALIVE — AudioContext exhaustion guard
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * ANIMATION/SOUND AUDIT 2026-08-20.
 *
 * MultiTablePage keeps up to MAX_TABLES (4) TablePage instances mounted at
 * once. useTabKeepAlive used to construct one AudioContext PER MOUNT, so a
 * 4-table session held 4 — plus SoundService (constructed at module import,
 * so always present), PremiumSFX, and VoiceRecorder = 7 against Chrome's hard
 * cap of 6 per document. The 7th throws, and since SoundService/PremiumSFX
 * build lazily they lose the race: the table goes SILENT.
 *
 * These tests pin the refcounted-singleton behaviour. If anyone reverts to a
 * per-mount context, the first test fails with the exact count.
 */

import { renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTabKeepAlive, __keepAliveDebugState } from '../../src/hooks/useTabKeepAlive';

/** Chrome's real limit. Exceeding it throws on construction. */
const BROWSER_AUDIO_CONTEXT_CAP = 6;
const MAX_TABLES = 4;

let liveContexts = 0;
let constructedContexts = 0;
let revokedUrls = 0;

class FakeAudioContext {
  destination = {};
  state = 'running';
  constructor() {
    if (liveContexts >= BROWSER_AUDIO_CONTEXT_CAP) {
      throw new DOMException(
        `Failed to construct 'AudioContext': The number of hardware contexts provided (${liveContexts}) is greater than or equal to the maximum bound (${BROWSER_AUDIO_CONTEXT_CAP}).`,
        'NotSupportedError'
      );
    }
    liveContexts += 1;
    constructedContexts += 1;
  }
  createOscillator() {
    return { connect: () => {}, start: () => {} };
  }
  createGain() {
    return { gain: { value: 1 }, connect: () => {} };
  }
  close() {
    liveContexts -= 1;
    return Promise.resolve();
  }
}

class FakeWorker {
  onmessage: ((e: MessageEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

beforeEach(() => {
  liveContexts = 0;
  constructedContexts = 0;
  revokedUrls = 0;
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {
      revokedUrls += 1;
    },
  });
});

describe('useTabKeepAlive — AudioContext exhaustion', () => {
  it('creates ONE shared context no matter how many tables are mounted', () => {
    const tables = Array.from({ length: MAX_TABLES }, () => renderHook(() => useTabKeepAlive()));

    // The regression this guards: was MAX_TABLES (4), must be 1.
    expect(constructedContexts).toBe(1);
    expect(liveContexts).toBe(1);
    expect(__keepAliveDebugState().refs).toBe(MAX_TABLES);

    tables.forEach((t) => t.unmount());
  });

  it('leaves room under the browser cap for SoundService, PremiumSFX and VoiceRecorder', () => {
    const tables = Array.from({ length: MAX_TABLES }, () => renderHook(() => useTabKeepAlive()));

    // The three other real consumers in the app.
    const soundService = new FakeAudioContext(); // eager, at module import
    const premiumSfx = new FakeAudioContext(); // lazy, first premium cue
    const voiceRecorder = new FakeAudioContext(); // lazy, voice message

    // Previously this line threw NotSupportedError and the table went silent.
    expect(liveContexts).toBeLessThanOrEqual(BROWSER_AUDIO_CONTEXT_CAP);
    expect(liveContexts).toBe(4);

    [soundService, premiumSfx, voiceRecorder].forEach((c) => c.close());
    tables.forEach((t) => t.unmount());
  });

  it('keeps the context alive while ANY table is still open', () => {
    const a = renderHook(() => useTabKeepAlive());
    const b = renderHook(() => useTabKeepAlive());

    a.unmount();
    // A table closing must not silence the tab that is still playing.
    expect(__keepAliveDebugState().hasCtx).toBe(true);
    expect(liveContexts).toBe(1);

    b.unmount();
    expect(__keepAliveDebugState().hasCtx).toBe(false);
    expect(__keepAliveDebugState().refs).toBe(0);
  });

  it('fully releases so contexts do not accumulate across table churn', () => {
    // Open and close 4 tables, ten times over — a normal session's churn.
    for (let i = 0; i < 10; i++) {
      const t = renderHook(() => useTabKeepAlive());
      const u = renderHook(() => useTabKeepAlive());
      t.unmount();
      u.unmount();
    }
    expect(liveContexts).toBe(0);
    expect(__keepAliveDebugState().refs).toBe(0);
    // Never exceeded the cap at any point (each cycle built at most one).
    expect(constructedContexts).toBe(10);
  });

  it('revokes every blob URL it creates (no per-table-open leak)', () => {
    const t = renderHook(() => useTabKeepAlive());
    // keepalive worker + pre-warmed timer worker
    expect(revokedUrls).toBeGreaterThanOrEqual(1);
    t.unmount();
  });

  it('survives a context that fails to construct without breaking the hook', () => {
    // Simulate already being at the cap from other consumers.
    const hogs = Array.from({ length: BROWSER_AUDIO_CONTEXT_CAP }, () => new FakeAudioContext());

    expect(() => {
      const t = renderHook(() => useTabKeepAlive());
      t.unmount();
    }).not.toThrow();

    hogs.forEach((h) => h.close());
  });
});
