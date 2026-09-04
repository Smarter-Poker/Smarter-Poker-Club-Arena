/**
 * ===============================================================================
 *  THE SENTRY SURFACE - the only door between this app and @sentry/react
 * ===============================================================================
 *
 * WHY THIS FILE EXISTS
 * `import('@sentry/react')` hands the bundler a live namespace object. It cannot
 * know which properties will be read off it, so it keeps the package whole -
 * every integration ships whether or not a line of this app ever calls it.
 * Measured 2026-08-21: the vendor-sentry chunk carried `@sentry-internal/feedback`
 * (76 kB of source) purely on the chance that somebody might reach for it. Nobody
 * does; the feedback widget is not part of this product.
 *
 * Named imports are the fix. Rollup can see exactly which exports are reachable
 * and drop the rest, and this file is still only ever reached through a dynamic
 * import - so the chunk stays lazy and the entry bundle is unaffected.
 *
 * THE RULE
 * Add an export here when the app genuinely needs one more piece of the Sentry
 * API, and never widen this back to a namespace import. A namespace re-import
 * anywhere in `src/` undoes the whole file: `grep -rn "@sentry/react" src/`
 * should only ever find this one.
 *
 * FREE TIER (2026-09-04, docs/SENTRY-FREE-TIER-POLICY.md): `replayIntegration`,
 * `reactRouterV6BrowserTracingIntegration`, `startSpan` and `setMeasurement`
 * are gone from this list on purpose. Replay and tracing are OFF, not sampled
 * low, and an export nobody may call is an export the bundler still ships.
 * Do not add them back without a line in that policy naming the daily cost.
 */

import {
  addBreadcrumb,
  captureException,
  captureMessage,
  globalHandlersIntegration,
  init,
  setUser,
  showReportDialog,
  withScope,
} from '@sentry/react';

export {
  addBreadcrumb,
  captureException,
  captureMessage,
  globalHandlersIntegration,
  init,
  setUser,
  showReportDialog,
  withScope,
};

/**
 * The shape every consumer sees. Deliberately structural rather than
 * `typeof import('@sentry/react')`: a consumer typed against the whole package
 * would compile against methods this bundle does not carry, and that failure
 * would surface at runtime in production rather than here.
 */
export type SentrySurface = {
  addBreadcrumb: typeof addBreadcrumb;
  captureException: typeof captureException;
  captureMessage: typeof captureMessage;
  globalHandlersIntegration: typeof globalHandlersIntegration;
  init: typeof init;
  setUser: typeof setUser;
  showReportDialog: typeof showReportDialog;
  withScope: typeof withScope;
};
