/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE IMAGE — 3D renders from Supabase storage (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Replaces the hand-drawn SVG icon set (ThrowableIcons.tsx, deleted) with the
 * 49 high-quality 3D renders in the `images` bucket (`throwables/<id>.jpg`).
 *
 * The renders ship on PURE BLACK backgrounds. `mix-blend-mode: screen` makes
 * black mathematically transparent over the arena UI — no alpha channel
 * needed — while the item itself stays vivid. The .throwable-img class
 * carrying the blend mode lives in ThrowAnimation.css.
 *
 * Also exports preloadThrowableImages() — call it when the table mounts (or
 * the selector opens) so the first throw never pops in half-loaded.
 */

import React, { useState } from 'react';
import {
  getThrowableImageUrl,
  getThrowableRawUrl,
  throwableService,
} from '../../services/ThrowableService';

interface ThrowableImageProps {
  throwableId: string;
  size: number;
  className?: string;
  /** Browser-native loading hint. Selector grid uses 'lazy'; projectiles 'eager'. */
  loading?: 'eager' | 'lazy';
}

export function ThrowableImage({
  throwableId,
  size,
  className = '',
  loading = 'eager',
}: ThrowableImageProps) {
  // Error ladder: sized transform URL -> raw full-size URL -> glyph.
  // (If the /render/image/ endpoint is ever disabled, throws still render.)
  const [errorStep, setErrorStep] = useState<0 | 1 | 2>(0);
  const sized = getThrowableImageUrl(throwableId, size);
  const url = errorStep === 0 ? sized : errorStep === 1 ? getThrowableRawUrl(throwableId) : '';

  if (!url || errorStep >= 2) {
    // Storage unreachable — keep the layout, show a neutral chip glyph.
    return (
      <span
        className={`throwable-img throwable-img--fallback ${className}`}
        style={{ width: size, height: size, fontSize: size * 0.6, lineHeight: `${size}px` }}
        aria-hidden
      >
        ◎
      </span>
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
      className={`throwable-img ${className}`}
      onError={() => setErrorStep((prev) => (prev < 2 ? ((prev + 1) as 0 | 1 | 2) : prev))}
    />
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRELOADER
// ═══════════════════════════════════════════════════════════════════════════════

let preloadStarted = false;

/**
 * Warm the browser cache for all 49 renders. Idempotent; runs during idle
 * time so it never competes with the table's own critical loads.
 */
export function preloadThrowableImages(): void {
  if (preloadStarted || typeof window === 'undefined') return;
  preloadStarted = true;

  const warm = () => {
    for (const t of throwableService.getThrowables()) {
      // Both retina buckets: 96 (selector tiles) + 160 (flight/impact).
      // Sized through /render/image/ these are a few KB each — warming all
      // 98 costs ~1 MB total, where the old full-size warm pulled ~22 MB.
      for (const px of [40, 64]) {
        const url = getThrowableImageUrl(t.id, px);
        if (!url) continue;
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
      }
    }
  };

  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(warm, { timeout: 4000 });
  } else {
    setTimeout(warm, 1500);
  }
}

export default ThrowableImage;
