import { capture } from '../../lib/analytics';
import { isNativePlatform, nativePlatform } from '../../lib/appBase';
import { iosWebkitVersion, vibrationPath } from '../../utils/vibrationGate';

/**
 * WHAT PLAYERS' PHONES ACTUALLY DO WITH THE DIAMOND SCENES (2026-10-01).
 *
 * Every test of these scenes ran on a computer imitating a phone. This sends
 * one short, anonymous summary per scene visit to the product analytics the app
 * already uses (src/lib/analytics.ts: PostHog, only after the player's consent,
 * and a no-op wherever no key is configured), so the real picture is known
 * without asking anyone to open the Device Check:
 *
 *   diamond_scene_session  the game, the kind of device, the screen's pixel
 *                          ratio, whether the GPU or the CPU draws, the quality
 *                          tier the scene started and ended on, the frames a
 *                          second it held while moving, its share of slow
 *                          frames, and how this device can buzz.
 *   diamond_scene_failed   the game, why the scene could not draw (no WebGL,
 *                          the context lost, or a stalled reveal), and the
 *                          kind of device.
 *
 * Nothing personal is sent: no account, no club, no amounts. A visit with too
 * little motion to measure (under MIN_MOVING_FRAMES) sends nothing.
 */
/** The 3D scenes, and the wheel, whose spins are drawn frame by frame too (Phase 4). */
export type SceneGame = 'crash' | 'plinko' | 'crossing' | 'wheel';
export type SceneFailure = 'renderer' | 'context_lost' | 'stalled';

/** Fewer moving frames than this say nothing about smoothness. */
export const MIN_MOVING_FRAMES = 30;
/** A moving frame later than this after the one before it was a slow one. */
export const SLOW_FRAME_MS = 34;

export function deviceKind(): 'app_ios' | 'app_android' | 'ios_web' | 'android_web' | 'desktop' {
  if (isNativePlatform()) return nativePlatform() === 'android' ? 'app_android' : 'app_ios';
  if (iosWebkitVersion() !== null) return 'ios_web';
  try {
    if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || ''))
      return 'android_web';
  } catch {
    /* no navigator */
  }
  return 'desktop';
}

function pixelRatio(): number {
  try {
    return Math.round((window.devicePixelRatio || 1) * 100) / 100;
  } catch {
    return 1;
  }
}

/** One scene that could not draw. */
export function reportSceneFailure(game: SceneGame, reason: SceneFailure): void {
  capture('diamond_scene_failed', { game, reason, device: deviceKind(), dpr: pixelRatio() });
}

export interface SceneTelemetry {
  /** One drawn frame; `moving` is true while the scene draws at full rate. */
  frame(now: number, moving: boolean): void;
  /** The quality tier now in force. */
  tier(index: number): void;
  /** The visit ended (unmount): sends the summary once, if there was enough motion. */
  end(): void;
}

export function createSceneTelemetry(
  game: SceneGame,
  options: { software: boolean; startTier: number }
): SceneTelemetry {
  let movingFrames = 0,
    movingMs = 0,
    slow = 0,
    last = -1,
    endTier = options.startTier,
    sent = false;
  return {
    frame(now, moving) {
      if (!moving) {
        last = -1;
        return;
      }
      if (last >= 0) {
        const gap = now - last;
        // A gap over a second is a pause (a hidden tab), not a frame.
        if (gap > 0 && gap < 1000) {
          movingFrames += 1;
          movingMs += gap;
          if (gap > SLOW_FRAME_MS) slow += 1;
        }
      }
      last = now;
    },
    tier(index) {
      endTier = index;
    },
    end() {
      if (sent || movingFrames < MIN_MOVING_FRAMES || movingMs <= 0) return;
      sent = true;
      capture('diamond_scene_session', {
        game,
        device: deviceKind(),
        dpr: pixelRatio(),
        software: options.software,
        start_tier: options.startTier,
        end_tier: endTier,
        fps: Math.round((movingFrames * 1000) / movingMs),
        slow_share: Math.round((slow / movingFrames) * 100) / 100,
        vibration: vibrationPath(),
      });
    },
  };
}
