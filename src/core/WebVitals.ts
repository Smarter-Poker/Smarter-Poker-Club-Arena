/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  WEB VITALS — Core Web Vitals Performance Monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reports Core Web Vitals (LCP, FID, CLS, FCP, TTFB, INP) to:
 *   1. Console (dev mode)
 *   2. Sentry custom metrics (production)
 *
 * Low-risk, additive only — does NOT modify any existing behavior.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

const isDev = import.meta.env.DEV;

/**
 * Send metric to Sentry as a custom measurement
 */
function sendToSentry(metric: Metric) {
  try {
    // Dynamic import to avoid hard dependency if Sentry isn't loaded
    import('./sentryBundle')
      .then((Sentry) => {
        Sentry.setMeasurement(
          metric.name,
          metric.value,
          metric.name === 'CLS' ? '' : 'millisecond'
        );

        // Also add as breadcrumb for contextual debugging
        Sentry.addBreadcrumb({
          category: 'web-vitals',
          message: `${metric.name}: ${Math.round(metric.value)}${metric.name === 'CLS' ? '' : 'ms'}`,
          level: metric.rating === 'poor' ? 'warning' : 'info',
          data: {
            value: metric.value,
            rating: metric.rating,
            delta: metric.delta,
            id: metric.id,
            navigationType: metric.navigationType,
          },
        });
      })
      .catch(() => {
        // Silent fail — Sentry may be blocked by ad blockers or unavailable
      });
  } catch {
    // Silent fail — metrics are non-critical
  }
}

/**
 * Log metric to console in dev mode with color-coded rating
 */
function logToConsole(metric: Metric) {
  const colors: Record<string, string> = {
    good: 'color: #0CCE6B; font-weight: bold',
    'needs-improvement': 'color: #FFA400; font-weight: bold',
    poor: 'color: #FF4E42; font-weight: bold',
  };

  const unit = metric.name === 'CLS' ? '' : 'ms';
  const value = metric.name === 'CLS' ? metric.value.toFixed(3) : Math.round(metric.value);

  console.debug(
    `%c[WebVitals] ${metric.name}: ${value}${unit} (${metric.rating})`,
    colors[metric.rating] || ''
  );
}

/**
 * Handle a web vital metric — route to appropriate reporters
 */
function handleMetric(metric: Metric) {
  if (isDev) {
    logToConsole(metric);
  }

  // Only send to Sentry in production — skip in dev to avoid unnecessary dynamic imports
  if (!isDev) {
    sendToSentry(metric);
  }
}

/**
 * Initialize Core Web Vitals monitoring.
 * Call once in main.tsx after app boot.
 *
 * Metrics collected:
 * - LCP (Largest Contentful Paint) — loading performance
 * - FCP (First Contentful Paint) — initial render speed
 * - CLS (Cumulative Layout Shift) — visual stability
 * - INP (Interaction to Next Paint) — responsiveness
 * - TTFB (Time to First Byte) — server response time
 */
export function initWebVitals() {
  try {
    onLCP(handleMetric);
    onFCP(handleMetric);
    onCLS(handleMetric);
    onINP(handleMetric);
    onTTFB(handleMetric);
  } catch {
    // Silent fail — web vitals are non-critical monitoring
  }
}
