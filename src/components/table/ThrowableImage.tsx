/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE IMAGE — approved premium artwork
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The 47 redesigned non-glove stills ship as local, versioned thumbnails.
 * The original glove retains its existing Storage source. Both paths use
 * real alpha cutouts at runtime for their opaque source backgrounds.
 *
 * BACKGROUND HANDLING (rewritten 2026-08-21 — Dan: "it throws it + background,
 * looks like trash")
 * The original approach was `mix-blend-mode: screen`, which is a no-op over
 * MATHEMATICALLY pure black. JPEG black is not pure: it is 8/8/8, 3/12/6, and
 * it rings around every high-contrast edge, so each of those pixels lightened
 * the felt — the grey box around every throw. Screen also never darkens, so
 * the dark parts of dark items washed out, and over the selector's light glass
 * panel the whole trick fell apart.
 *
 * Now: ThrowableCutout computes a REAL alpha channel (border flood fill, so
 * dark pixels INSIDE an item survive) and returns a blob URL. Those render with
 * normal compositing — no blend mode, no wash, no box, correct over any
 * backdrop.
 *
 * The cutout is strictly an upgrade. Until it resolves — and forever, if canvas
 * or CORS is unavailable — the component falls back to the raw image with the
 * old screen blend, which is what shipped before. Nothing regresses.
 *
 * Delivery uses approved local premium thumbnails for the 47 non-glove items.
 * The supplied glove artwork retains its existing source.
 * Error ladder: cutout -> thumbnail -> larger source -> unavailable marker.
 */

import React, { useEffect, useState } from 'react';
import {
  getThrowableImageUrl,
  getThrowableRawUrl,
  throwableService,
} from '../../services/ThrowableService';
import { getThrowableCutout, peekThrowableCutout } from '../../services/ThrowableCutout';

interface ThrowableImageProps {
  throwableId: string;
  size: number;
  className?: string;
  /** Browser-native loading hint. Selector grid uses 'lazy'; projectiles 'eager'. */
  loading?: 'eager' | 'lazy';
}

export function ThrowableImage(props: ThrowableImageProps) {
  // Both the fallback ladder and asynchronous cutout belong to one asset.
  // Remount synchronously so reused selector cells cannot paint the previous
  // item's cutout or retain its exhausted error state for a new item/size.
  return <ThrowableImageForAsset key={`${props.throwableId}:${props.size}`} {...props} />;
}

function ThrowableImageForAsset({
  throwableId,
  size,
  className = '',
  loading = 'eager',
}: ThrowableImageProps) {
  const [errorStep, setErrorStep] = useState<0 | 1 | 2>(0);
  // Synchronous peek first: once a cutout exists for this id+bucket the very
  // first paint uses it, so a throw never flashes the black-backed original.
  const [cutout, setCutout] = useState<string | null>(() => peekThrowableCutout(throwableId, size));

  useEffect(() => {
    let alive = true;
    const ready = peekThrowableCutout(throwableId, size);
    if (ready) {
      setCutout(ready);
      return;
    }
    setCutout(null);
    getThrowableCutout(throwableId, size)
      .then((url) => {
        if (alive) setCutout(url);
      })
      .catch(() => {
        // Keying impossible (CORS, no canvas, odd asset). Stay on the blended
        // original — the pre-2026-08-21 behaviour.
        if (alive) setCutout(null);
      });
    return () => {
      alive = false;
    };
  }, [throwableId, size]);

  const sized = getThrowableImageUrl(throwableId, size);
  const fallbackUrl =
    errorStep === 0 ? sized : errorStep === 1 ? getThrowableRawUrl(throwableId) : '';
  const url = cutout || fallbackUrl;

  if (!url || (!cutout && errorStep >= 2)) {
    // Preserve layout without substituting a generic glyph for missing artwork.
    return (
      <span
        className={`throwable-img throwable-img--fallback ${className}`}
        style={{ width: size, height: size }}
        role="img"
        aria-label="Artwork Unavailable"
      />
    );
  }

  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading={loading}
      decoding="async"
      draggable={false}
      // --cut carries normal compositing; without it the class keeps the
      // legacy screen blend that the black-backed original still needs.
      className={`throwable-img ${cutout ? 'throwable-img--cut' : ''} ${className}`}
      onError={() => {
        // A failed BLOB is not a storage problem — drop to the plain image
        // rather than burning a rung of the storage ladder.
        if (cutout) setCutout(null);
        else setErrorStep((prev) => (prev < 2 ? ((prev + 1) as 0 | 1 | 2) : prev));
      }}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRELOADER
// ═══════════════════════════════════════════════════════════════════════════════

let preloadStarted = false;

/**
 * Warm all 49 renders AND their cutouts during idle time, so the first throw
 * is transparent from its first frame instead of keying mid-flight.
 *
 * Cutouts are built sequentially with a yield between each: 49 canvas keys in
 * one burst would jank the table. Sized through /render/image/ each source is
 * a few KB, so the whole warm is ~1 MB (the old full-size warm pulled ~22 MB).
 */
export function preloadThrowableImages(): void {
  if (preloadStarted || typeof window === 'undefined') return;
  preloadStarted = true;

  const warm = async () => {
    const items = throwableService.getThrowables();

    // Cheap network warm first — both retina buckets, so either surface is hot.
    for (const t of items) {
      for (const px of [84, 128]) {
        const url = getThrowableImageUrl(t.id, px);
        if (!url) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }

    // Then the expensive part, one at a time, yielding to the event loop.
    const idle = (): Promise<void> =>
      new Promise((r) => {
        if ('requestIdleCallback' in window) {
          (window as any).requestIdleCallback(() => r(), { timeout: 200 });
        } else {
          setTimeout(r, 16);
        }
      });

    for (const t of items) {
      for (const px of [84, 128]) {
        try {
          await getThrowableCutout(t.id, px);
        } catch {
          /* keying unavailable for this asset; the blended original still works */
        }
        await idle();
      }
    }
  };

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(() => void warm(), { timeout: 4000 });
  } else {
    setTimeout(() => void warm(), 1500);
  }
}

export default ThrowableImage;
