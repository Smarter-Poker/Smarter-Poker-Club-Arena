/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useFrameBudgetMonitor — Bible V8 §9.1.3 Performance Instrumentation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Monitors frame timing to detect when UI updates exceed the 16ms budget (60fps).
 * Uses PerformanceObserver with 'longtask' entry type where available,
 * falls back to requestAnimationFrame delta measurement.
 *
 * Only active in development mode to avoid any production overhead.
 * Logs warnings when frame budget is exceeded.
 */

import { useEffect, useRef } from 'react';

const FRAME_BUDGET_MS = 16; // 60fps = 16.67ms per frame
const LONG_FRAME_THRESHOLD_MS = 50; // Only warn for truly problematic frames
const MAX_VIOLATIONS_LOGGED = 20; // Don't spam console

export function useFrameBudgetMonitor(enabled = true): void {
  const violationCount = useRef(0);

  useEffect(() => {
    // Only run in development
    if (!enabled || import.meta.env.PROD) return;

    // Method 1: PerformanceObserver for Long Tasks (50ms+ blocks)
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (violationCount.current < MAX_VIOLATIONS_LOGGED) {
              violationCount.current++;
              console.warn(
                `§9.1.3 LONG TASK: ${Math.round(entry.duration)}ms (>${FRAME_BUDGET_MS}ms budget)`,
                entry.name
              );
            }
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // longtask not supported in this browser
        observer = null;
      }
    }

    // Method 2: RAF-based frame delta measurement
    let rafId: number;
    let lastFrameTime = performance.now();

    const measureFrame = (now: number) => {
      const delta = now - lastFrameTime;
      if (delta > LONG_FRAME_THRESHOLD_MS && violationCount.current < MAX_VIOLATIONS_LOGGED) {
        violationCount.current++;
        console.warn(
          `§9.1.3 FRAME DROP: ${Math.round(delta)}ms between frames (${Math.round(1000 / delta)}fps)`
        );
      }
      lastFrameTime = now;
      rafId = requestAnimationFrame(measureFrame);
    };

    rafId = requestAnimationFrame(measureFrame);

    return () => {
      cancelAnimationFrame(rafId);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [enabled]);
}
