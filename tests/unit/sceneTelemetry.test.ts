/**
 * WHAT PLAYERS' PHONES ACTUALLY DO WITH THE DIAMOND SCENES (2026-10-01): one
 * anonymous summary per visit, and one report per scene that could not draw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock('../../src/lib/analytics', () => analytics);
const db = vi.hoisted(() => ({ rpc: vi.fn(() => Promise.resolve({ data: null, error: null })) }));
vi.mock('../../src/lib/supabase', () => ({ supabase: db }));
// The app's writer, installed exactly as the game pages install it.
import { installDiamondSceneRecorder } from '../../src/services/DiamondSceneRecorder';
installDiamondSceneRecorder();
import { readFileSync } from 'node:fs';
import {
  createSceneTelemetry,
  deviceKind,
  MIN_MOVING_FRAMES,
  reportSceneFailure,
} from '../../src/components/games/sceneTelemetry';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.5 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  analytics.capture.mockClear();
  db.rpc.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('the scene summary', () => {
  it('reports the frames a second held while moving, the slow share and the tiers, once', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, maxTouchPoints: 5 });
    const t = createSceneTelemetry('crash', { software: false, startTier: 0 });
    let now = 0;
    // 120 frames at 60 a second, then 10 slow ones at 20 a second.
    for (let i = 0; i < 120; i++) t.frame((now += 1000 / 60), true);
    for (let i = 0; i < 10; i++) t.frame((now += 50), true);
    t.tier(1);
    t.end();
    t.end();
    expect(analytics.capture).toHaveBeenCalledTimes(1);
    const [event, props] = analytics.capture.mock.calls[0];
    expect(event).toBe('diamond_scene_session');
    expect(props).toMatchObject({
      game: 'crash',
      device: 'ios_web',
      software: false,
      start_tier: 0,
      end_tier: 1,
      vibration: 'ios-taps',
    });
    expect(props.fps).toBeGreaterThanOrEqual(50);
    expect(props.fps).toBeLessThanOrEqual(56);
    expect(props.slow_share).toBeCloseTo(10 / 129, 1);
    expect(Object.keys(props)).not.toEqual(expect.arrayContaining(['userId', 'clubId']));
    // The same numbers reach the platform's own rollup, once, with no user in them.
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('fn_record_diamond_scene', {
      p_game: 'crash',
      p_device: 'ios_web',
      p_software: false,
      p_end_tier: 1,
      p_frames: 129,
      p_ms: expect.any(Number),
      p_slow: 10,
      p_failure: null,
    });
  });

  it('sends the summary when the tab closes, and only once', () => {
    const t = createSceneTelemetry('plinko', { software: true, startTier: 0 });
    let now = 0;
    for (let i = 0; i < 60; i++) t.frame((now += 16), true);
    window.dispatchEvent(new Event('pagehide'));
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc.mock.calls[0][1]).toMatchObject({ p_game: 'plinko', p_software: true });
    t.end();
    window.dispatchEvent(new Event('pagehide'));
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it('never lets a refused write reach the game', async () => {
    db.rpc.mockReturnValueOnce(Promise.reject(new Error('offline')));
    const t = createSceneTelemetry('crash', { software: false, startTier: 0 });
    let now = 0;
    for (let i = 0; i < 60; i++) t.frame((now += 16), true);
    expect(() => t.end()).not.toThrow();
    await Promise.resolve();
  });

  it('measures only motion: settled frames and pauses are not counted', () => {
    const t = createSceneTelemetry('plinko', { software: true, startTier: 3 });
    let now = 0;
    for (let i = 0; i < 40; i++) t.frame((now += 16), true);
    for (let i = 0; i < 100; i++) t.frame((now += 33), false);
    now += 5000; // a hidden tab
    for (let i = 0; i < 40; i++) t.frame((now += 16), true);
    t.end();
    const props = analytics.capture.mock.calls[0][1];
    expect(props.fps).toBe(63);
    expect(props.slow_share).toBe(0);
  });

  it('sends nothing for a visit with too little motion to measure', () => {
    const t = createSceneTelemetry('crossing', { software: false, startTier: 0 });
    let now = 0;
    for (let i = 0; i < MIN_MOVING_FRAMES - 5; i++) t.frame((now += 16), true);
    t.end();
    expect(analytics.capture).not.toHaveBeenCalled();
  });
});

describe('a scene that could not draw', () => {
  it('is reported with its reason and the kind of device', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/140 Mobile' });
    expect(deviceKind()).toBe('android_web');
    reportSceneFailure('plinko', 'context_lost');
    expect(analytics.capture).toHaveBeenCalledWith(
      'diamond_scene_failed',
      expect.objectContaining({ game: 'plinko', reason: 'context_lost', device: 'android_web' })
    );
    expect(db.rpc).toHaveBeenCalledWith(
      'fn_record_diamond_scene',
      expect.objectContaining({
        p_game: 'plinko',
        p_device: 'android_web',
        p_failure: 'context_lost',
        p_frames: 0,
      })
    );
  });
});

describe('the standalone test page stays away from accounts', () => {
  it('the telemetry reaches the database only through the hook the game pages install', () => {
    const telemetry = readFileSync('src/components/games/sceneTelemetry.ts', 'utf8');
    const hook = readFileSync('src/components/games/sceneRecorder.ts', 'utf8');
    expect(telemetry).not.toMatch(/lib\/supabase/);
    expect(hook).not.toMatch(/^import /m);
    for (const page of [
      'DiamondCrashPage',
      'DiamondPlinkoPage',
      'DiamondChoicePage',
      'DiamondWheelPage',
    ])
      expect(readFileSync(`src/pages/${page}.tsx`, 'utf8')).toContain(
        'installDiamondSceneRecorder();'
      );
  });
});
