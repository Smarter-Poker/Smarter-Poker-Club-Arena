import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  createQualityGovernor,
  FLOOR_TIER,
  QUALITY_STORAGE_KEY,
  QUALITY_TIERS,
  REFUSED_SHARE,
  rememberedTier,
  WARMUP_FRAMES,
  WARMUP_MS,
  WINDOW_FRAMES,
  RESUME_GAP_MS,
} from '../../src/components/games/qualityGovernor';
import { applyQualityTier, COMPILE_WAIT_MS, warmUp } from '../../src/components/games/sceneKit';

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    store,
  };
}

/** Drive a governor through its warm-up: enough frames and enough time, all healthy. */
function warm(
  governor: ReturnType<typeof createQualityGovernor>,
  clock: { now: number },
  interval = 16
) {
  for (let i = 0; i < WARMUP_FRAMES + 2; i++) {
    clock.now += Math.max(interval, WARMUP_MS / WARMUP_FRAMES);
    governor.frame(clock.now, true);
  }
}

describe('the quality governor steps a scene down when its frames say so', () => {
  it('applies the best tier at once and never touches it while frames are healthy', () => {
    const apply = vi.fn();
    const clock = { now: 0 };
    const governor = createQualityGovernor({ intervalMs: 16, apply, storage: memoryStorage() });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(QUALITY_TIERS[0], 0);
    warm(governor, clock);
    for (let i = 0; i < WINDOW_FRAMES * 5; i++) {
      clock.now += 16;
      governor.frame(clock.now, true);
    }
    expect(governor.tier).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('holds during the warm-up, then steps down once a whole window is GPU bound', () => {
    const apply = vi.fn();
    const clock = { now: 0 };
    const storage = memoryStorage();
    const governor = createQualityGovernor({ intervalMs: 16, apply, storage });
    // Refused frames during warm-up are forgiven: programs are still linking.
    for (let i = 0; i < WARMUP_FRAMES - 1; i++) {
      clock.now += 16;
      governor.frame(clock.now, false);
    }
    expect(governor.tier).toBe(0);
    warm(governor, clock);
    // Half of every window refused: the GPU cannot keep up.
    for (let i = 0; i < WINDOW_FRAMES; i++) {
      clock.now += 16;
      governor.frame(clock.now, i % 2 === 0);
    }
    expect(governor.tier).toBe(1);
    expect(apply).toHaveBeenLastCalledWith(QUALITY_TIERS[1], 1);
    expect(storage.getItem(QUALITY_STORAGE_KEY)).toBe('1');
  });

  it('steps down when drawn frames arrive far slower than the scene draws', () => {
    const apply = vi.fn();
    const clock = { now: 0 };
    const governor = createQualityGovernor({ intervalMs: 30, apply, storage: memoryStorage() });
    warm(governor, clock, 30);
    for (let i = 0; i < WINDOW_FRAMES; i++) {
      clock.now += 90; // three times the interval: a 30 ms scene drawing at 11 a second
      governor.frame(clock.now, true);
    }
    expect(governor.tier).toBe(1);
  });

  it('warms up again after a step and stops at the floor', () => {
    const apply = vi.fn();
    const clock = { now: 0 };
    const governor = createQualityGovernor({ intervalMs: 16, apply, storage: memoryStorage() });
    warm(governor, clock);
    const condemn = () => {
      for (let i = 0; i < WINDOW_FRAMES; i++) {
        clock.now += 16;
        governor.frame(clock.now, false);
      }
    };
    condemn();
    expect(governor.tier).toBe(1);
    // Straight after a step the next window is a warm-up, not a verdict.
    condemn();
    expect(governor.tier).toBe(1);
    for (let round = 0; round < 12; round++) {
      warm(governor, clock);
      condemn();
    }
    expect(governor.tier).toBe(FLOOR_TIER);
    expect(apply).toHaveBeenCalledTimes(FLOOR_TIER + 1);
    expect(QUALITY_TIERS[FLOOR_TIER]).toEqual({ ratio: 1, shadows: false });
  });

  it('starts the next scene at the tier this session already found, and a CPU rasteriser at the floor', () => {
    const apply = vi.fn();
    createQualityGovernor({
      intervalMs: 16,
      apply,
      storage: memoryStorage({ [QUALITY_STORAGE_KEY]: '2' }),
    });
    expect(apply).toHaveBeenLastCalledWith(QUALITY_TIERS[2], 2);
    createQualityGovernor({ intervalMs: 16, apply, storage: memoryStorage(), start: FLOOR_TIER });
    expect(apply).toHaveBeenLastCalledWith(QUALITY_TIERS[FLOOR_TIER], FLOOR_TIER);
    expect(rememberedTier(memoryStorage({ [QUALITY_STORAGE_KEY]: 'nine' }))).toBe(0);
    expect(rememberedTier(memoryStorage({ [QUALITY_STORAGE_KEY]: '99' }))).toBe(0);
    expect(rememberedTier(null)).toBe(0);
    expect(REFUSED_SHARE).toBeGreaterThan(0.2);
  });
});

describe('the governor judges a frame against the pace it was drawn at', () => {
  const walk = (
    governor: ReturnType<typeof createQualityGovernor>,
    from: number,
    gap: number,
    n: number,
    interval?: number
  ) => {
    let t = from;
    for (let i = 0; i < n; i++) {
      t += gap;
      governor.frame(t, true, interval);
    }
    return t;
  };

  it('does not step a reduced-motion loop down for drawing at its own slow pace', () => {
    const apply = vi.fn();
    const governor = createQualityGovernor({ intervalMs: 30, apply, storage: memoryStorage() });
    // A reduced-motion Crash loop draws every 180 ms, for many windows.
    walk(governor, 0, 180, 600, 180);
    expect(governor.tier).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('still steps a loop down that runs well behind the pace it asked for', () => {
    const governor = createQualityGovernor({
      intervalMs: 30,
      apply: vi.fn(),
      storage: memoryStorage(),
    });
    walk(governor, 0, 180, 200, 30);
    expect(governor.tier).toBeGreaterThan(0);
  });

  it('treats a long gap (hidden tab, paused scene) as a pause, not a slow frame', () => {
    const governor = createQualityGovernor({
      intervalMs: 16,
      apply: vi.fn(),
      storage: memoryStorage(),
    });
    let t = walk(governor, 0, 16, 60);
    // Drawn only when something changes, seconds apart, for several windows.
    for (let i = 0; i < 300; i++) {
      t += RESUME_GAP_MS + 500;
      governor.frame(t, true);
    }
    expect(governor.tier).toBe(0);
  });
});

describe('a document that denies storage still gets a governor', () => {
  it('treats a sessionStorage read that throws as no storage at all', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('Access is denied for this document.', 'SecurityError');
      },
    });
    try {
      const apply = vi.fn();
      const governor = createQualityGovernor({ intervalMs: 16, apply });
      expect(governor.tier).toBe(0);
      expect(apply).toHaveBeenCalledTimes(1);
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  });
});

describe('a tier is put on the renderer', () => {
  it('caps the pixel ratio at the device and re-links materials when shadows change', () => {
    const renderer = {
      setPixelRatio: vi.fn(),
      setSize: vi.fn(),
      shadowMap: { enabled: true },
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    material.needsUpdate = false;
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), material));
    const original = window.devicePixelRatio;
    Object.defineProperty(window, 'devicePixelRatio', { value: 3, configurable: true });
    applyQualityTier(renderer, scene, { ratio: 1.5, shadows: true }, 300, 200);
    expect(renderer.setPixelRatio).toHaveBeenLastCalledWith(1.5);
    expect(renderer.setSize).toHaveBeenLastCalledWith(300, 200, false);
    const versionBefore = material.version;
    applyQualityTier(renderer, scene, { ratio: 1, shadows: false }, 300, 200);
    expect(renderer.shadowMap.enabled).toBe(false);
    expect(material.version).toBeGreaterThan(versionBefore);
    Object.defineProperty(window, 'devicePixelRatio', { value: original, configurable: true });
  });
});

describe('the programs are compiled before the first frame', () => {
  it('is ready when compileAsync answers, and after the wait when it does not', () => {
    vi.useFakeTimers();
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera();
    let resolve: () => void = () => {};
    const ready = vi.fn();
    warmUp(
      { compileAsync: () => new Promise<void>((r) => (resolve = r)) as unknown as Promise<object> },
      scene,
      camera,
      ready
    );
    expect(ready).not.toHaveBeenCalled();
    resolve();
    return Promise.resolve().then(async () => {
      await Promise.resolve();
      expect(ready).toHaveBeenCalledTimes(1);
      const late = vi.fn();
      warmUp({ compileAsync: () => new Promise(() => {}) }, scene, camera, late);
      vi.advanceTimersByTime(COMPILE_WAIT_MS - 1);
      expect(late).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(late).toHaveBeenCalledTimes(1);
      const none = vi.fn();
      warmUp({}, scene, camera, none);
      expect(none).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });
  });
});
