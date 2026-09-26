import { nativePlatform, isNativePlatform } from '../../lib/appBase';
import { iosWebkitVersion, vibrationPath, type VibrationPath } from '../../utils/vibrationGate';
import { QUALITY_STORAGE_KEY, QUALITY_TIERS, rememberedTier } from '../games/qualityGovernor';
import { isSoftwareRenderer } from '../games/rendererTier';

/**
 * What the device check reports, as plain words a player (or Dan, holding his
 * own phone) can read and paste back. Pure where it can be, so the words are
 * tested; the probes that need a real browser are small and fail soft.
 */

/** The kind of device and browser this is. */
export function deviceLabel(): string {
  if (isNativePlatform()) {
    const p = nativePlatform();
    return p === 'ios'
      ? 'Club Arena App On IPhone'
      : p === 'android'
        ? 'Club Arena App On Android'
        : 'Club Arena App';
  }
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || '';
  const ios = iosWebkitVersion();
  if (ios !== null) {
    // Safari 26 froze the OS number in its user agent at 18.6; its own
    // Version/ token still moves, so name that when it is there.
    const safari = /Version\/(\d+(?:\.\d+)?)/.exec(ua);
    return safari
      ? `IPhone Or IPad Browser (Safari ${safari[1]})`
      : `IPhone Or IPad Browser (Reports IOS ${ios.toFixed(1)})`;
  }
  if (/Android/i.test(ua)) return 'Android Browser';
  return 'Computer Browser';
}

/** What the Vibrations switch can actually do here. */
export function vibrationSummary(path: VibrationPath = vibrationPath()): string {
  switch (path) {
    case 'app':
      return "Full: The Phone's Own Haptic Engine";
    case 'vibrate-api':
      return 'Full: The Vibration Motor, Where The Device Has One';
    case 'ios-taps':
      return 'Taps Only: IPhone Browsers Can Only Buzz Under Your Finger';
    default:
      return 'None: This Browser Cannot Vibrate';
  }
}

/** The one line under the Vibrations switch, or null when there is nothing to warn about. */
export function vibrationHint(path: VibrationPath = vibrationPath()): string | null {
  if (path === 'ios-taps') return 'On IPhone Browsers, Buttons Buzz As You Tap Them.';
  if (path === 'none') return 'This Browser Cannot Vibrate.';
  if (path === 'vibrate-api' && !isTouchDevice()) return 'Buzzes On Phones With A Vibration Motor.';
  return null;
}

export function isTouchDevice(): boolean {
  try {
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
  } catch {
    return false;
  }
}

/** How the silent switch treats game sound here. */
export function silentSwitchSummary(session: string | null, soundOn: boolean): string {
  if (session === null) return 'Not Applicable On This Browser';
  if (!soundOn) return 'Sounds Are Off In Settings';
  return session === 'playback'
    ? 'Heard With The Silent Switch On'
    : 'Muted When The Silent Switch Is On';
}

const TIER_NAMES = ['Full', 'High', 'Standard', 'Low (No Shadows)'];

/** The graphics quality this session has settled on (the Diamond games' governor). */
export function qualityTierLabel(storage: Pick<Storage, 'getItem'> | null): string {
  let tier = 0;
  try {
    tier = rememberedTier(storage);
  } catch {
    tier = 0;
  }
  const t = QUALITY_TIERS[tier];
  return `${TIER_NAMES[tier] ?? 'Full'} (${t.ratio}x Pixels${t.shadows ? ', Shadows' : ''})`;
}

export { QUALITY_STORAGE_KEY };

/** The WebGL renderer's name and whether it is the CPU, probed once on a throwaway canvas. */
export function probeGraphics(): { renderer: string; software: boolean; webgl: boolean } {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return { renderer: 'WebGL Unavailable', software: false, webgl: false };
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) ||
        gl.getParameter(gl.RENDERER) ||
        'Unknown'
    );
    const software = isSoftwareRenderer(gl);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, software, webgl: true };
  } catch {
    return { renderer: 'WebGL Unavailable', software: false, webgl: false };
  }
}

/** Frames per second and the share of slow frames, from a list of frame timestamps. */
export function smoothness(stamps: readonly number[]): { fps: number; slowShare: number } | null {
  if (stamps.length < 3) return null;
  const span = stamps[stamps.length - 1] - stamps[0];
  if (span <= 0) return null;
  let slow = 0;
  for (let i = 1; i < stamps.length; i++) if (stamps[i] - stamps[i - 1] > 34) slow += 1;
  return {
    fps: Math.round(((stamps.length - 1) * 1000) / span),
    slowShare: slow / (stamps.length - 1),
  };
}

/** The whole check as text, for Copy Report. */
export function reportText(rows: ReadonlyArray<readonly [string, string]>): string {
  return ['Club Arena Device Check', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
}
