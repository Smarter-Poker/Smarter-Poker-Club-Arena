/**
 * THE WHEEL ON A CHEAP PHONE (2026-10-01).
 *
 * The wheel's decoration is 48 lamps, each its own compositor layer, a blurred
 * aura and a pointer glow. On a phone with little memory those layers compete
 * with the spin itself for the GPU. "Lite" keeps every element and the spin
 * exactly as they are and stops only the decoration's motion: the lamps hold a
 * steady glow as one painted layer, the aura loses its blur, the pointer glow
 * rests.
 *
 * A wheel starts lite on a device that reports 2 GB of memory or less, and any
 * wheel turns lite for the rest of the visit once a spin shows it cannot keep
 * up: a quarter or more of its frames slow, over at least 30 frames.
 */
export const WHEEL_SLOW_FRAME_MS = 34;
export const WHEEL_MIN_FRAMES = 30;
export const WHEEL_SLOW_SHARE = 0.25;

let demoted = false;

/** Whether a wheel mounting now should start lite. */
export function wheelStartsLite(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (demoted) return true;
  const memory = (nav as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory;
  return typeof memory === 'number' && memory > 0 && memory <= 2;
}

/**
 * Watches one spin's frames. `frame` returns true exactly once: on the frame
 * that proves the device cannot keep up, after which every wheel this visit
 * starts lite.
 */
export function createWheelFrameWatch() {
  let frames = 0;
  let slow = 0;
  let decided = false;
  return {
    frame(elapsedMs: number): boolean {
      if (decided || !(elapsedMs > 0)) return false;
      frames += 1;
      if (elapsedMs > WHEEL_SLOW_FRAME_MS) slow += 1;
      if (frames >= WHEEL_MIN_FRAMES && slow / frames >= WHEEL_SLOW_SHARE) {
        decided = true;
        demoted = true;
        return true;
      }
      return false;
    },
  };
}

/** Tests only: forget a demotion. */
export function resetWheelLite(): void {
  demoted = false;
}
