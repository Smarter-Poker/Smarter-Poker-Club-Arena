/**
 * THE SCENE MEASURES ITSELF AND STEPS DOWN BEFORE THE PLAYER FEELS IT.
 *
 * Dan, 2026-09-21: "the mobile play is very choppy and not smooth and crisp".
 * A phone that reports a hardware GPU can still be a cheap one, and the only
 * honest way to know is to watch the frames it actually delivers. Every WebGL
 * scene hands this governor one sample per attempted frame: the clock, and
 * whether the frame was submitted (gpuFrameRenderer refuses a frame while the
 * previous one is still on the GPU). Two symptoms are read from a rolling
 * window of attempts:
 *
 *   - the GPU is the wall: a large share of attempts were refused because the
 *     last frame had not finished (the fence was still busy);
 *   - the main thread is the wall: the time between drawn frames runs well
 *     past the scene's own draw interval.
 *
 * Either one, sustained for a whole window after a warm-up, steps the scene
 * down one quality tier: 2x device pixels, 1.5x, 1x, then 1x with shadow maps
 * off. Nothing else changes: every element, colour and animation stays, only
 * the resolution and the shadows go. The governor only steps down; a step up
 * would oscillate on exactly the devices that need it, and a round lasts
 * seconds. The lowest tier reached is remembered for the session so the next
 * scene on the same device starts there instead of rediscovering it.
 *
 * A CPU rasteriser (rendererTier.ts) starts at the floor tier outright.
 */
export interface QualityTier {
  /** Device pixel ratio ceiling for the canvas. */
  ratio: number;
  /** Whether the shadow-casting light draws a shadow map. */
  shadows: boolean;
}

export const QUALITY_TIERS: readonly QualityTier[] = [
  { ratio: 2, shadows: true },
  { ratio: 1.5, shadows: true },
  { ratio: 1, shadows: true },
  { ratio: 1, shadows: false },
];
export const FLOOR_TIER = QUALITY_TIERS.length - 1;

/** Frames per window: enough to outlast a garbage-collection pause or a tab switch, short enough to act inside a round. */
export const WINDOW_FRAMES = 60;
/** Frames ignored after a start or a step, while programs compile and caches warm. */
export const WARMUP_FRAMES = 30;
/** Milliseconds ignored after a start or a step, whatever the frame count. */
export const WARMUP_MS = 1500;
/** A window with more refused frames than this is GPU bound. */
export const REFUSED_SHARE = 0.35;
/** A window whose drawn frames arrive this many times later than the scene's interval is main-thread bound. */
export const SLOW_FACTOR = 1.8;
/** Share of slow frames that condemns a window. */
export const SLOW_SHARE = 0.4;

export const QUALITY_STORAGE_KEY = 'ca:diamond-scene-quality';

/** The remembered floor for this session, or the best tier when nothing was remembered. */
export function rememberedTier(storage: Pick<Storage, 'getItem'> | null | undefined): number {
  try {
    const raw = storage?.getItem(QUALITY_STORAGE_KEY);
    const tier = raw === null || raw === undefined ? 0 : Number.parseInt(raw, 10);
    return Number.isInteger(tier) && tier >= 0 && tier <= FLOOR_TIER ? tier : 0;
  } catch {
    return 0;
  }
}

function remember(storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined, tier: number) {
  try {
    if (!storage) return;
    if (tier > rememberedTier(storage)) storage.setItem(QUALITY_STORAGE_KEY, String(tier));
  } catch {
    /* storage refused (private mode, quota): the tier still applies this scene */
  }
}

/**
 * The session store, or null where reading it throws: a document with storage
 * denied (a sandboxed frame, some private modes, a page set by setContent)
 * raises a SecurityError on the mere property read, and a scene must draw there
 * all the same.
 */
function sessionStorageIfAllowed(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export interface GovernorOptions {
  /** The scene's own draw interval in milliseconds (the throttle in its frame loop). */
  intervalMs: number;
  /** Called with the tier to apply, now and after every step. */
  apply: (tier: QualityTier, index: number) => void;
  /** Start here (a CPU rasteriser passes FLOOR_TIER). Defaults to the remembered tier. */
  start?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
}

export interface QualityGovernor {
  /** One attempted frame: the clock it ran on and whether it was submitted. */
  frame(now: number, submitted: boolean): void;
  /** The tier in force. */
  readonly tier: number;
}

export function createQualityGovernor(options: GovernorOptions): QualityGovernor {
  const storage = options.storage === undefined ? sessionStorageIfAllowed() : options.storage;
  let tier = Math.max(options.start ?? rememberedTier(storage), rememberedTier(storage));
  tier = Math.min(FLOOR_TIER, Math.max(0, tier));
  options.apply(QUALITY_TIERS[tier], tier);
  const slowAfter = options.intervalMs * SLOW_FACTOR + 8;
  let attempts = 0,
    refused = 0,
    slow = 0,
    warming = true,
    warmFrames = 0,
    warmSince = -1,
    lastDrawn = -1;
  /** A new window; after a step the scene warms up again, after a clean window it does not. */
  const reset = (now: number, warm: boolean) => {
    attempts = refused = slow = 0;
    warming = warm;
    warmFrames = 0;
    warmSince = warm ? now : -1;
    if (warm) lastDrawn = -1;
  };
  return {
    get tier() {
      return tier;
    },
    frame(now, submitted) {
      if (tier >= FLOOR_TIER) return;
      if (warming) {
        if (warmSince < 0) warmSince = now;
        warmFrames += 1;
        if (submitted) lastDrawn = now;
        if (warmFrames >= WARMUP_FRAMES && now - warmSince >= WARMUP_MS) warming = false;
        return;
      }
      attempts += 1;
      if (!submitted) refused += 1;
      else {
        if (lastDrawn >= 0 && now - lastDrawn > slowAfter) slow += 1;
        lastDrawn = now;
      }
      if (attempts < WINDOW_FRAMES) return;
      const gpuBound = refused / attempts > REFUSED_SHARE;
      const cpuBound = slow / attempts > SLOW_SHARE;
      if (gpuBound || cpuBound) {
        tier += 1;
        remember(storage, tier);
        options.apply(QUALITY_TIERS[tier], tier);
      }
      reset(now, gpuBound || cpuBound);
    },
  };
}
