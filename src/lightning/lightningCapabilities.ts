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

/* LIGHTNING PHASE 8: a handheld plays more than one Cluster too, up to its
   own (smaller) limit: tablets 3 and phones 2 by default (multi_table_limit). */
const HANDHELD: Readonly<LightningCapabilities> = Object.freeze({
  fast_fold: true,
  fold_and_watch: false,
  multi_table: true,
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
  /** Viewport height in CSS pixels (tells a tablet from a phone). */
  viewportHeight?: number;
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
  return {
    nativePlatform,
    coarsePointer,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

// ─── LIGHTNING PHASE 8: the device class and its Cluster limit ─────────────

/**
 * The three device classes the database's `multi_table_limit` is keyed by.
 * This is what the client reports to the engine for the matcher; it is a
 * different question from `LightningPlatform` (which controls to show).
 */
export type LightningDeviceClass = 'desktop' | 'tablet' | 'mobile';

/**
 * How many Clusters a player may hold Lightning sessions in at once, by
 * device class: fn_lightning_config's `multi_table_limit` defaults. The
 * database enforces the real number in the matcher; the client uses these to
 * say so before a join, never to spend or refuse money.
 */
export const LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS: Readonly<Record<LightningDeviceClass, number>> =
  Object.freeze({ desktop: 4, tablet: 3, mobile: 2 });

/** A handheld whose shorter side is at least this wide is a tablet. */
export const LIGHTNING_TABLET_MIN_SHORT_SIDE = 600;

/**
 * Desktop unless the device is held: the native shell or a finger as the
 * primary pointer. A held device is a tablet when its shorter side is at
 * least 600 CSS px, and a phone otherwise. A narrow desktop window is still
 * a desktop: the limit is about the device, not the window.
 */
export function lightningDeviceClass(signals: LightningPlatformSignals): LightningDeviceClass {
  const held =
    signals.nativePlatform === 'ios' ||
    signals.nativePlatform === 'android' ||
    signals.coarsePointer === true;
  if (!held) return 'desktop';
  const w = Number(signals.viewportWidth);
  const h = Number(signals.viewportHeight);
  const sides = [w, h].filter((n) => Number.isFinite(n) && n > 0);
  if (sides.length === 0) return 'mobile';
  return Math.min(...sides) >= LIGHTNING_TABLET_MIN_SHORT_SIDE ? 'tablet' : 'mobile';
}

/** The Cluster limit for a device class (the defaults; unknown reads as the phone's). */
export function lightningMultiTableLimit(device: LightningDeviceClass | string): number {
  return (
    (LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS as Record<string, number>)[device] ??
    LIGHTNING_MULTI_TABLE_LIMIT_DEFAULTS.mobile
  );
}
