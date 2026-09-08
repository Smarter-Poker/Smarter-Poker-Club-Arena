/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE CUTOUT — real transparency for the 3D renders
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE PROBLEM (Dan, 2026-08-21: "it throws it + background, looks like trash")
 * The 49 renders are JPGs on a pure-black background. The original approach was
 * `mix-blend-mode: screen`, on the theory that screen over black is a no-op
 * (result = 1-(1-a)(1-b), and b=0 leaves the backdrop). That holds for
 * MATHEMATICALLY pure black, and these images are not:
 *
 *   1. JPEG is lossy. The "black" is 8/8/8, 3/12/6, 14/9/11 ... never 0/0/0,
 *      and it rings badly around high-contrast edges. Every one of those
 *      non-zero pixels LIGHTENS the felt under it. That is the grey box
 *      around every throw.
 *   2. Screen never darkens. Dark parts of the ITEM also get washed toward the
 *      backdrop, so the renders look milky and flat.
 *   3. Screen only behaves at all over a dark backdrop. Over the selector's
 *      glass panel, or a light table theme, it is visibly wrong.
 *
 * THE FIX
 * Compute a real alpha channel once per image, in the browser, and hand the
 * <img> a blob URL with genuine transparency. No blend mode, no washing, no
 * box — and it is correct over any backdrop.
 *
 * WHY FLOOD FILL, NOT A LUMINANCE THRESHOLD
 * A global "dark pixel => transparent" rule eats the dark PARTS of dark items:
 * the bomb's body, the skull's sockets, the trash can, the shark. This floods
 * inward from the BORDER and only removes background actually connected to the
 * edge. Dark pixels enclosed by the item survive, because you cannot reach them
 * from outside without crossing the item.
 *
 * Edges are feathered rather than cut hard: pixels between HARD and SOFT get a
 * proportional alpha, which dissolves the JPEG ringing halo instead of leaving
 * a crunchy outline.
 *
 * SAFETY
 * Canvas readback requires CORS. Supabase serves public objects with
 * `access-control-allow-origin: *`, and the image is requested with
 * crossOrigin="anonymous". If anything fails — tainted canvas, no 2D context, a
 * decode error, an implausible result — the caller falls back to the original
 * URL and the previous rendering path. A cutout is an upgrade, never a
 * dependency.
 */

import { getThrowableImageUrl, getThrowableRawUrl } from './ThrowableService';

/**
 * Colour distance from the SAMPLED background at/below which a
 * border-connected pixel is definitely background.
 */
const HARD = 26;
/** Colour distance above which a pixel is definitely NOT background. */
const SOFT = 74;
/** Clean local artwork needs a narrow band to preserve dark material at 192px. */
export const PREMIUM_THROWABLE_MATTE = { hard: 2, soft: 8 } as const;

const cache = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();
const objectUrls: string[] = [];

// MUST mirror getThrowableImageUrl's buckets exactly, or a cutout gets cached
// under a key no reader ever asks for and every lookup silently misses.
const bucketOf = (px: number) => (px <= 96 ? 192 : 320);

/**
 * Median colour of the frame's border, i.e. the background.
 *
 * Dan 2026-08-21: "make sure all backgrounds are black, a couple are white."
 * Rather than police the source assets — which only fixes the two we know
 * about, and breaks again the next time someone generates a render on a light
 * ground — the keyer now MEASURES the background instead of assuming it. Black,
 * white, grey, or any future colour all key identically.
 *
 * Median, not mean: an item bleeding off the edge skews a mean toward the item
 * and would make the keyer treat the background as "not background". A median
 * ignores that minority.
 */
function sampleBackground(data: Uint8ClampedArray, w: number, h: number): [number, number, number] {
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const take = (idx: number) => {
    rs.push(data[idx * 4]);
    gs.push(data[idx * 4 + 1]);
    bs.push(data[idx * 4 + 2]);
  };
  for (let x = 0; x < w; x++) {
    take(x);
    take((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    take(y * w);
    take(y * w + (w - 1));
  }
  const mid = (arr: number[]) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length / 2)];
  };
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * Chebyshev (max-channel) distance from the background colour. Cheap, and for
 * a UNIFORM background it separates subject from ground more crisply than
 * Euclidean, which dilutes a single strongly-differing channel across three.
 */
function bgDistance(data: Uint8ClampedArray, i: number, bg: [number, number, number]): number {
  const dr = Math.abs(data[i * 4] - bg[0]);
  const dg = Math.abs(data[i * 4 + 1] - bg[1]);
  const db = Math.abs(data[i * 4 + 2] - bg[2]);
  return Math.max(dr, dg, db);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cutout: image failed to load (${src})`));
    img.src = src;
  });
}

/**
 * Flood the background inward from every border pixel and write alpha.
 * Iterative stack, not recursion: a 160x160 frame is 25k pixels and a mostly
 * empty background would blow the call stack.
 *
 * Returns how many pixels were made non-opaque, for the plausibility check.
 */
export function knockOutBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  matte = { hard: HARD, soft: SOFT }
): number {
  const { hard, soft } = matte;
  const n = w * h;
  const bg = sampleBackground(data, w, h);
  // `lum` is now "distance from the background colour", not luminance. On the
  // black renders the two are numerically identical (distance from 0/0/0 IS
  // the channel value), which is why the thresholds did not need retuning.
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = bgDistance(data, i, bg);
  }

  const isBg = new Uint8Array(n);
  const stack: number[] = [];

  // Seed from the frame border. Anything darker than SOFT on the edge is
  // background; brighter means the item bleeds off-frame, so we do not seed
  // there and that edge simply stays opaque.
  const seed = (idx: number) => {
    if (!isBg[idx] && lum[idx] < soft) {
      isBg[idx] = 1;
      stack.push(idx);
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + (w - 1));
  }

  while (stack.length) {
    const idx = stack.pop() as number;
    const x = idx % w;
    const y = (idx - x) / w;
    // 4-connected: avoids leaking through diagonal JPEG noise into the item.
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (y > 0) seed(idx - w);
    if (y < h - 1) seed(idx + w);
  }

  let cleared = 0;
  const span = soft - hard;
  for (let i = 0; i < n; i++) {
    if (!isBg[i]) continue; // enclosed dark pixels are part of the item
    const l = lum[i];
    if (l <= hard) {
      data[i * 4 + 3] = 0;
      cleared++;
    } else {
      // Feather across the ringing band so edges stay smooth.
      const a = Math.min(255, Math.max(0, Math.round(((l - hard) / span) * 255)));
      data[i * 4 + 3] = a;
      if (a < 250) cleared++;
    }
  }
  return cleared;
}

async function buildCutout(id: string, px: number): Promise<string> {
  let img: HTMLImageElement;
  try {
    img = await loadImage(getThrowableImageUrl(id, px));
  } catch {
    // Transform endpoint unavailable — try the original before giving up.
    img = await loadImage(getThrowableRawUrl(id));
  }

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('cutout: image has no dimensions');

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('cutout: no 2d context');
  ctx.drawImage(img, 0, 0);

  // Throws SecurityError if the canvas is tainted (CORS refused).
  const frame = ctx.getImageData(0, 0, w, h);
  // Fresh local PNG-derived thumbnails have a clean matte. The aggressive
  // legacy JPEG tolerance erased dark fur, black props and cuffs.
  const cleanMatte = getThrowableImageUrl(id, px).includes('images/throwables/stylized/');
  const cleared = knockOutBackground(
    frame.data,
    w,
    h,
    cleanMatte ? PREMIUM_THROWABLE_MATTE : undefined
  );

  // Plausibility: an image that keys to almost nothing, or to almost
  // everything, does not match the "subject on black" assumption. Refuse
  // rather than ship a hole or a box.
  const ratio = cleared / (w * h);
  if (ratio < 0.02 || ratio > 0.985) {
    throw new Error(`cutout: implausible key ratio ${ratio.toFixed(3)} for ${id}`);
  }

  ctx.putImageData(frame, 0, 0);

  const blob: Blob = await new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('cutout: toBlob returned null'))),
      'image/png'
    )
  );
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  resolved.set(`${id}@${bucketOf(px)}`, url);
  return url;
}

/**
 * Transparent version of a throwable render. Resolves to a blob: URL, or
 * REJECTS when keying is not possible — callers must fall back to the plain
 * image on rejection.
 *
 * One cutout per (id, size bucket); the promise is cached so simultaneous
 * callers share a single decode.
 */
export function getThrowableCutout(id: string, px = 320): Promise<string> {
  const bucket = bucketOf(px);
  const key = `${id}@${bucket}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // URL selection takes display pixels, not the already-normalized cache
  // bucket. Passing 192 here selected the 320px source for every small icon.
  const p = buildCutout(id, px).catch((err) => {
    cache.delete(key); // allow a later retry (transient network, etc.)
    throw err;
  });
  cache.set(key, p);
  return p;
}

/** Already-resolved cutout URL, or null. Lets render paths avoid a flash. */
export function peekThrowableCutout(id: string, px = 320): string | null {
  return resolved.get(`${id}@${bucketOf(px)}`) ?? null;
}

/** Release every blob URL this module created (route teardown / tests). */
export function releaseThrowableCutouts(): void {
  for (const u of objectUrls.splice(0)) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* already gone */
    }
  }
  cache.clear();
  resolved.clear();
}
