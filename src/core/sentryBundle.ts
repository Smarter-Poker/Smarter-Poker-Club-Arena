/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE SENTRY SURFACE — the only door between this app and @sentry/react
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS
 * `import('@sentry/react')` hands the bundler a live namespace object. It cannot
 * know which properties will be read off it, so it keeps the package whole —
 * every integration ships whether or not a line of this app ever calls it.
 * Measured 2026-08-21: the vendor-sentry chunk carried `@sentry-internal/feedback`
 * (76 kB of source) purely on the chance that somebody might reach for it. Nobody
 * does; the feedback widget is not part of this product.
 *
 * Named imports are the fix. Rollup can see exactly which exports are reachable
 * and drop the rest, and this file is still only ever reached through a dynamic
 * import — so the chunk stays lazy and the entry bundle is unaffected.
 *
 * THE RULE
 * Add an export here when the app genuinely needs one more piece of the Sentry
 * API, and never widen this back to a namespace import. A namespace re-import
 * anywhere in `src/` undoes the whole file: `grep -rn "@sentry/react" src/`
 * should only ever find this one.
 */

import {
  addBreadcrumb,
  captureException,
  captureMessage,
  init,
  reactRouterV6BrowserTracingIntegration,
  replayIntegration,
  setContext,
  setMeasurement,
  setTag,
  setTags,
  setUser,
  showReportDialog,
  startSpan,
  withScope,
} from '@sentry/react';

export {
  addBreadcrumb,
  captureException,
  captureMessage,
  init,
  reactRouterV6BrowserTracingIntegration,
  replayIntegration,
  setContext,
  setMeasurement,
  setTag,
  setTags,
  setUser,
  showReportDialog,
  startSpan,
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
  init: typeof init;
  reactRouterV6BrowserTracingIntegration: typeof reactRouterV6BrowserTracingIntegration;
  replayIntegration: typeof replayIntegration;
  setContext: typeof setContext;
  setMeasurement: typeof setMeasurement;
  setTag: typeof setTag;
  setTags: typeof setTags;
  setUser: typeof setUser;
  showReportDialog: typeof showReportDialog;
  startSpan: typeof startSpan;
  withScope: typeof withScope;
};
