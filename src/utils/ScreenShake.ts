/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SCREEN SHAKE — Dramatic Visual Feedback for Big Moments
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Triggers a brief CSS-based screen shake on the table container.
 * Uses `translate3d` for GPU-accelerated performance.
 *
 * Usage:
 *   triggerScreenShake('medium')   // Normal win
 *   triggerScreenShake('heavy')    // Monster pot
 *   triggerScreenShake('light')    // Fold/action emphasis
 */

export type ShakeIntensity = 'light' | 'medium' | 'heavy';

const SHAKE_CONFIG: Record<
  ShakeIntensity,
  { amplitude: number; duration: number; frequency: number }
> = {
  light: { amplitude: 1.5, duration: 200, frequency: 30 },
  medium: { amplitude: 3, duration: 350, frequency: 25 },
  heavy: { amplitude: 5, duration: 500, frequency: 20 },
};

/**
 * Trigger a screen shake on the given element (or document.body).
 * Returns a cleanup function to cancel early.
 */
export function triggerScreenShake(
  intensity: ShakeIntensity = 'medium',
  targetEl?: HTMLElement | null
): () => void {
  const el = targetEl || document.body;
  const { amplitude, duration, frequency } = SHAKE_CONFIG[intensity];

  const startTime = performance.now();
  let frameId = 0;

  // Save original transform
  const originalTransform = el.style.transform;

  const shake = (now: number) => {
    const elapsed = now - startTime;
    const progress = elapsed / duration;

    if (progress >= 1) {
      // Restore original
      el.style.transform = originalTransform;
      return;
    }

    // Decay amplitude over time
    const decay = 1 - progress;

    // Random offset within amplitude range
    const offsetX = (Math.random() - 0.5) * 2 * amplitude * decay;
    const offsetY = (Math.random() - 0.5) * 2 * amplitude * decay * 0.6;

    el.style.transform = `${originalTransform} translate3d(${offsetX}px, ${offsetY}px, 0)`;

    frameId = requestAnimationFrame(shake);
  };

  frameId = requestAnimationFrame(shake);

  return () => {
    cancelAnimationFrame(frameId);
    el.style.transform = originalTransform;
  };
}

/**
 * React hook-friendly: returns a ref callback and trigger function.
 */
export function useScreenShake() {
  let targetRef: HTMLElement | null = null;

  const setRef = (el: HTMLElement | null) => {
    targetRef = el;
  };

  const shake = (intensity: ShakeIntensity = 'medium') => {
    return triggerScreenShake(intensity, targetRef);
  };

  return { setRef, shake };
}

export default triggerScreenShake;

// stress-test 060524-2: pipeline timing probe, no behaviour change.
