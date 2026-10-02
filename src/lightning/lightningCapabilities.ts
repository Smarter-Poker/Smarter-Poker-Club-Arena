/**
 * LIGHTNING PHASE 6: WHAT EACH PLATFORM OFFERS A LIGHTNING PLAYER.
 *
 * One map, keyed by platform, with the seven switches the specification
 * names. Domain logic never asks "is this a phone"; it is handed the row for
 * the platform it runs on and reads the switch. The only code that knows how
 * a platform is recognised is `detectLightningPlatform`, which the UI layer
 * calls once and passes down.
 *
 * FOLD & WATCH is a desktop control by default: on a phone the screen that
 * would keep showing the folded hand is the same screen the next hand needs.
 * LIGHTNING FOLD is offered everywhere, because it is the game.
 *
 * This is presentation per form factor. It is not the technical capability
 * registry (src/config/platformCapabilities.ts), which answers whether a
 * capability is offered at all and is read from the database.
 */

export type LightningPlatform = 'desktop' | 'mobile_web' | 'ios' | 'android';

export interface LightningCapabilities {
  /** LIGHTNING FOLD: leave the hand at once and take the next one. */
  fast_fold: boolean;
  /** FOLD & WATCH: fold and keep watching the hand play out. */
  fold_and_watch: boolean;
  /** More than one Lightning stream at a time. */
  multi_table: boolean;
  /** Keyboard shortcuts for the Lightning controls. */
  hotkeys: boolean;
  /** The running session summary. */
  session_stats: boolean;
  /** Replaying a finished hand from the stream. */
  replay: boolean;
  /** Table sound. */
  sound: boolean;
}

export const LIGHTNING_PLATFORMS: readonly LightningPlatform[] = [
  'desktop',
  'mobile_web',
  'ios',
  'android',
] as const;

const HANDHELD: Readonly<LightningCapabilities> = Object.freeze({
  fast_fold: true,
  fold_and_watch: false,
  multi_table: false,
  hotkeys: false,
  session_stats: true,
  replay: true,
  sound: true,
});

export const LIGHTNING_CAPABILITY_MAP: Readonly<
  Record<LightningPlatform, Readonly<LightningCapabilities>>
> = Object.freeze({
  desktop: Object.freeze({
    fast_fold: true,
    fold_and_watch: true,
    multi_table: true,
    hotkeys: true,
    session_stats: true,
    replay: true,
    sound: true,
  }),
  mobile_web: HANDHELD,
  ios: HANDHELD,
  android: HANDHELD,
});

/** The row for one platform. An unrecognised name gets the handheld row, the narrower one. */
export function lightningCapabilities(platform: LightningPlatform | string): LightningCapabilities {
  const row = (LIGHTNING_CAPABILITY_MAP as Record<string, Readonly<LightningCapabilities>>)[
    platform
  ];
  return { ...(row ?? HANDHELD) };
}

export interface LightningPlatformSignals {
  /** 'ios' | 'android' inside the native shell, anything else on the web. */
  nativePlatform?: string | null;
  /** The primary pointer is coarse (a finger). */
  coarsePointer?: boolean;
  /** Viewport width in CSS pixels. */
  viewportWidth?: number;
}

/** Below this width the web build is a phone layout (the app is portrait-first at 375px). */
export const LIGHTNING_HANDHELD_MAX_WIDTH = 820;

/** Recognise the platform from plain signals, so the rule itself is testable. */
export function detectLightningPlatform(signals: LightningPlatformSignals): LightningPlatform {
  if (signals.nativePlatform === 'ios') return 'ios';
  if (signals.nativePlatform === 'android') return 'android';
  if (signals.coarsePointer === true) return 'mobile_web';
  const width = Number(signals.viewportWidth);
  if (Number.isFinite(width) && width > 0 && width <= LIGHTNING_HANDHELD_MAX_WIDTH) {
    return 'mobile_web';
  }
  return 'desktop';
}

/** The signals this browser gives, read once by the UI layer. */
export function readLightningPlatformSignals(): LightningPlatformSignals {
  if (typeof window === 'undefined') return {};
  let nativePlatform: string | null = null;
  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (cap && typeof cap.getPlatform === 'function') {
    try {
      nativePlatform = cap.getPlatform();
    } catch {
      nativePlatform = null;
    }
  }
  let coarsePointer = false;
  try {
    coarsePointer =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarsePointer = false;
  }
  return { nativePlatform, coarsePointer, viewportWidth: window.innerWidth };
}
