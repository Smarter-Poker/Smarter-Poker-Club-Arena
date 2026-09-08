/**
 * Store readiness, phase 5: the app feels like an app, and the web does not
 * change. Every native behaviour hangs off isNativePlatform() or the
 * html.ca-native class, and the plugin code stays in src/lib/native/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fsMod from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

// The plugin wrappers are what a native build reaches for; here they are
// recorded, not run (there is no phone under vitest).
const haptic = vi.fn(async () => true);
const shareBlob = vi.fn(async () => true);
vi.mock('../../src/lib/native/haptics', () => ({
  nativeHaptic: (...a: unknown[]) => haptic(...a),
}));
vi.mock('../../src/lib/native/share', () => ({
  nativeShareBlob: (...a: unknown[]) => shareBlob(...a),
}));

function pretendNative(on: boolean) {
  const w = window as unknown as { Capacitor?: unknown };
  if (on) w.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios' };
  else delete w.Capacitor;
}

describe('native feel, behaviourally (src/utils is importable, so it is imported)', () => {
  beforeEach(() => {
    haptic.mockClear();
    shareBlob.mockClear();
    localStorage.clear();
  });
  afterEach(() => pretendNative(false));

  it('haptics: inside the app the phone engine fires; in a browser with no motor nothing does', async () => {
    const gate = await import('../../src/utils/vibrationGate');
    gate.__resetVibrationCoalescing();
    pretendNative(true);
    expect(gate.isVibrationCapable()).toBe(true);
    expect(gate.fireVibration(10)).toBe(true);
    await vi.waitFor(() => expect(haptic).toHaveBeenCalledWith(10));

    gate.__resetVibrationCoalescing();
    pretendNative(false);
    // jsdom: no navigator.vibrate, not iOS -> no motor, and the engine is not reached.
    expect(gate.fireVibration(10)).toBe(false);
    expect(haptic).toHaveBeenCalledTimes(1);
  });

  it('haptics: the player switching vibration off silences the app engine too', async () => {
    const gate = await import('../../src/utils/vibrationGate');
    gate.__resetVibrationCoalescing();
    pretendNative(true);
    localStorage.setItem('vibrationsEnabled', 'false');
    expect(gate.fireVibration(10)).toBe(false);
    expect(haptic).not.toHaveBeenCalled();
  });

  it('exports: the app goes to the share sheet with the CSV bytes; the web goes to <a download>', async () => {
    const { downloadCsv } = await import('../../src/utils/downloadCsv');
    const g = globalThis as unknown as {
      URL: { createObjectURL?: unknown; revokeObjectURL?: unknown };
    };
    const hadCreate = typeof g.URL.createObjectURL === 'function';
    if (!hadCreate) {
      g.URL.createObjectURL = () => 'blob:test';
      g.URL.revokeObjectURL = () => {};
    }
    try {
      pretendNative(true);
      expect(downloadCsv('rake-report.csv', 'a,b\n1,2')).toBe(true);
      await vi.waitFor(() => expect(shareBlob).toHaveBeenCalledTimes(1));
      const [blob, name] = shareBlob.mock.calls[0] as unknown as [Blob, string];
      expect(name).toBe('rake-report.csv');
      expect(blob.type).toContain('text/csv');
      expect(await blob.text()).toBe('\uFEFFa,b\n1,2');

      pretendNative(false);
      const clicks: string[] = [];
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        clicks.push((this as HTMLAnchorElement).download);
      };
      try {
        expect(downloadCsv('rake-report.csv', 'a,b')).toBe(true);
      } finally {
        HTMLAnchorElement.prototype.click = orig;
      }
      expect(clicks).toEqual(['rake-report.csv']);
      expect(shareBlob).toHaveBeenCalledTimes(1);
    } finally {
      if (!hadCreate) {
        delete g.URL.createObjectURL;
        delete g.URL.revokeObjectURL;
      }
    }
  });
});

describe('native feel is gated, and the plugins stay behind src/lib/native/', () => {
  it('keep-awake: the plugin where wakeLock does not exist, same holder count', () => {
    const env = read('src/hooks/useTableEnvironment.ts');
    expect(env).toContain("import('../lib/native/keepAwake')");
    expect(env).toContain("if (!('wakeLock' in navigator)) return;");
    expect(env.indexOf('nativeKeepAwake(false)')).toBeGreaterThan(
      env.indexOf('LAST TABLE OUT releases')
    );
  });
  it('share cards go to the share sheet on native, and <a download> on the web', () => {
    expect(read('src/components/achievements/AchievementShareCard.tsx')).toContain(
      "import('../../lib/native/share')"
    );
    expect(read('src/components/stats/StatsShareCard.tsx')).toContain(
      "import('../../lib/native/share')"
    );
  });
  it('overscroll, touch-callout and felt selection are keyed on html.ca-native only', () => {
    const css = read('src/styles/club-engine.css');
    const block = css.slice(css.indexOf('THE APP (2026-09-08)'));
    expect(block).toContain('html.ca-native,\nhtml.ca-native body {');
    expect(block).toContain('overscroll-behavior-y: none;');
    expect(block).toContain('-webkit-touch-callout: none;');
    // and nowhere else in the global sheet is overscroll disabled for the web
    const before = css.slice(0, css.indexOf('THE APP (2026-09-08)'));
    expect(before).not.toMatch(/overscroll-behavior[a-z-]*:\s*none/);
    expect(read('index.html')).toContain(
      "if (NATIVE) document.documentElement.classList.add('ca-native');"
    );
  });
  it('safe areas use env() with a 0 fallback, so the web renders as before', () => {
    expect(read('src/components/common/Modal.css')).toContain(
      'padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));'
    );
    expect(read('src/components/common/BottomSheet.tsx')).toContain(
      "paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))'"
    );
  });
  it('a swipe row captures the pointer only after the drag is recognised', () => {
    const hook = read('src/hooks/useSwipeAction.ts');
    const down = hook.slice(hook.indexOf('onPointerDown'), hook.indexOf('onPointerMove'));
    expect(down).not.toContain('setPointerCapture');
    expect(hook).toContain('e.currentTarget.setPointerCapture(e.pointerId);');
  });
  it('the second AudioContext resumes on foreground too', () => {
    expect(read('src/services/PremiumSFX.ts')).toContain(
      "document.addEventListener('visibilitychange'"
    );
  });
  it('the dev scratch images are gone from the shipped bundle', () => {
    const { existsSync } = fsMod;
    for (const f of [
      'test3.jpg',
      'test_bounds.jpg',
      'test_boxes.jpg',
      'test_crop.jpg',
      'test_patch_750.jpg',
      'test_top_bounds.jpg',
    ]) {
      expect(existsSync(resolve(__dirname, '../../public/images', f)), f).toBe(false);
    }
  });
});
