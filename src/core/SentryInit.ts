/**
 * ===============================================================================
 *  SENTRY INITIALIZATION - lazy-loaded, budgeted, errors only
 * ===============================================================================
 *
 * Sentry is on the free Developer plan (2026-09-04, docs/SENTRY-FREE-TIER-POLICY.md):
 * 5,000 errors a month for the whole organisation, 50 session replays, 5M
 * spans. So this client sends ERRORS ONLY, and few of them:
 *
 *   - tracing is OFF (`tracesSampleRate: 0`, no BrowserTracing integration);
 *   - Session Replay is OFF (both replay rates 0, the integration is not
 *     loaded at all - it was 50 replays a month, which is not a feature);
 *   - `sampleRate: 0.25` - three in four errors never leave the browser;
 *   - beforeSend enforces the client budget (src/core/sentryClientBudget.ts):
 *     2 events per session, 3 per fingerprint per day, 40 per day.
 *
 * What is WORTH an event is decided upstream, by the context allowlist in
 * src/utils/errorReporter.ts: error boundaries, the unhandled-rejection net,
 * and a money action the server refused. Everything else is a console line.
 *
 * LAZY-LOADING: the Sentry surface (src/core/sentryBundle.ts) is loaded
 * dynamically after first render via requestIdleCallback, keeping it out of
 * the critical path. The public wrappers queue until it is ready.
 *
 * Nothing in beforeSend filters by error CLASS. The August audit found a
 * `/src/`-gated "Cannot read properties of null" drop that threw away every
 * real production null-deref once source maps stopped shipping, and a blanket
 * ReferenceError drop elsewhere. Known noise is named (AbortError, extension
 * frames, ResizeObserver, the fetch-failed family); a type is never a reason.
 */

import { reportError } from '../utils/errorReporter';
import type { SentrySurface } from './sentryBundle';
import { SentryClientBudget, clientFingerprintOf } from './sentryClientBudget';

// -- Module-level state --
let SentryModule: SentrySurface | null = null;
let initPromise: Promise<SentrySurface | null> | null = null;

/**
 * The client budget. One per page load; the daily counter lives in
 * localStorage so a reload does not reset it. Exported for tests only.
 */
export const clientBudget = new SentryClientBudget();

// Queue of actions to replay once Sentry loads
type QueuedAction = () => void;
const pendingQueue: QueuedAction[] = [];
const MAX_QUEUE = 50; // Cap to prevent memory leaks if Sentry never loads

function enqueue(action: QueuedAction) {
  if (SentryModule) {
    // Sentry already loaded - execute immediately
    try {
      action();
    } catch {
      /* silent */
    }
    return;
  }
  if (pendingQueue.length < MAX_QUEUE) {
    pendingQueue.push(action);
  }
}

function flushQueue() {
  while (pendingQueue.length > 0) {
    const action = pendingQueue.shift();
    try {
      action?.();
    } catch {
      /* silent */
    }
  }
}

/**
 * Get the Sentry module (returns null if not yet loaded).
 * Consumers needing direct access should await getSentryAsync() instead.
 */
export function getSentry() {
  return SentryModule;
}

/**
 * Get the Sentry module, loading it if necessary.
 * Returns null in development or if loading fails.
 */
export async function getSentryAsync(): Promise<SentrySurface | null> {
  if (SentryModule) return SentryModule;
  if (initPromise) return initPromise;
  return loadAndInitSentry();
}

type BeforeSendEvent = {
  message?: string;
  exception?: { values?: Array<{ type?: string; value?: string }> };
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
};

/**
 * The beforeSend Sentry is initialised with. Exported so a test can drive it
 * without a network or a real SDK: everything that decides whether an event
 * leaves the browser is in here.
 */
export function clientBeforeSend<E extends BeforeSendEvent>(
  event: E,
  hint: { originalException?: unknown }
): E | null {
  const error = hint.originalException as Error | undefined;

  if (error && typeof error === 'object') {
    if ('name' in error) {
      const name = String(error.name);
      if (name === 'AbortError') return null;
    }

    if ('message' in error) {
      const message = String(error.message);
      if (message.includes('Failed to fetch') || message.includes('NetworkError')) return null;
      if (message.includes('ResizeObserver')) return null;
      if (message.includes('signal is aborted') || message.includes('aborted')) return null;
      if (message.includes('Internal error')) return null;
    }

    if ('stack' in error) {
      const stack = String(error.stack);
      if (stack.includes('chrome-extension://') || stack.includes('moz-extension://')) return null;
    }
  }

  // The budget. Uncaught exceptions arrive here with no reportError context,
  // so the fingerprint falls back to the message head.
  const message =
    (error && typeof error === 'object' && 'message' in error && String(error.message)) ||
    event.message ||
    event.exception?.values?.[0]?.value ||
    '';
  const source = (event.contexts?.errorContext as { source?: string } | undefined)?.source;
  const verdict = clientBudget.admit(clientFingerprintOf(message, source));
  if (!verdict.allow) {
    console.warn(
      `[Sentry] event dropped by the client budget (${verdict.reason}); ` +
        `${verdict.sentToday} sent today, ${verdict.droppedThisSession} dropped this session`
    );
    return null;
  }
  event.tags = { ...(event.tags ?? {}), sentry_budget_sent_today: String(verdict.sentToday) };
  return event;
}

/**
 * Internal: load and initialize Sentry
 */
async function loadAndInitSentry(): Promise<SentrySurface | null> {
  const environment = import.meta.env.VITE_APP_ENV || 'production';
  if (environment === 'development') return null;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.debug('[Sentry] DSN not configured, skipping initialization');
    return null;
  }

  try {
    const Sentry = await import('./sentryBundle');

    Sentry.init({
      dsn,
      environment,
      // The release name MUST equal the one sentry-vite-plugin uploads maps
      // under, or no event can be symbolicated. Both are
      // `club-arena@${VITE_APP_VERSION}` now, and the publisher sets that to
      // the sha it is shipping.
      //
      // The fallback says `unknown`, not `1.0.0` (changed 2026-09-04). A build
      // with no VITE_APP_VERSION has no maps uploaded for it and never will -
      // that is a broken build, not version one. Reporting `1.0.0` made it
      // indistinguishable from a real release in the Sentry UI, so the one
      // symptom of a misconfigured publish looked like ordinary traffic. This
      // way the release list says so.
      release: `club-arena@${import.meta.env.VITE_APP_VERSION || 'unknown'}`,

      // Errors only. No Replay, no BrowserTracing: neither integration is
      // loaded, so a rate above 0 here would have nothing to sample anyway.
      // The rates are pinned to 0 as well so the intent survives a future
      // "helpful" integration import.
      integrations: [
        // Sentry's own window.onerror hook stays (an uncaught exception is on
        // the allowlist). Its onunhandledrejection hook is turned off because
        // main.tsx already reports every unhandled rejection through
        // reportError as `main.Unhandled_promise_rejection_caught`; with both
        // on, one rejection cost two of the session's two events.
        Sentry.globalHandlersIntegration({ onerror: true, onunhandledrejection: false }),
      ],
      tracesSampleRate: 0,
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      // A quarter of errors leave the browser; applied by the SDK before
      // beforeSend, so the budget below sees a quarter of any wave.
      sampleRate: 0.25,

      // Filter out noise from browser extensions and third-party scripts
      denyUrls: [
        /extensions\//i,
        /^chrome:\/\//i,
        /^moz-extension:\/\//i,
        /^safari-extension:\/\//i,
        /googletagmanager\.com/i,
        /graph\.facebook\.com/i,
      ],

      beforeSend: clientBeforeSend,

      ignoreErrors: [
        'top.GLOBALS',
        'chrome-extension',
        'moz-extension',
        "Can't find variable: ZiteReader",
        'jigsaw is not defined',
        'ComboSearch is not defined',
        'NetworkError',
        'Network request failed',
        'ResizeObserver loop limit exceeded',
        'ResizeObserver loop completed with undelivered notifications',
        'AbortError',
        'signal is aborted without reason',
        'signal is aborted',
        'The operation was aborted',
        'The user aborted a request',
        'UnknownError: Internal error',
        'Internal error',
      ],
    });

    SentryModule = Sentry;
    flushQueue();
    console.log('[Sentry] Lazy-loaded and initialized');
    return Sentry;
  } catch (error) {
    reportError(error, 'SentryInit.Initialization_failed');
    return null;
  }
}

/**
 * Initialize Sentry error tracking.
 * Lazy-loads the Sentry surface dynamically after first render.
 * Safe to call synchronously - the actual load happens in the background.
 */
export function initSentry() {
  const environment = import.meta.env.VITE_APP_ENV || 'production';
  if (environment === 'development') return;

  // Schedule load after first render / during idle time
  const scheduleLoad = () => {
    initPromise = loadAndInitSentry();
  };

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(scheduleLoad, { timeout: 3000 });
  } else {
    setTimeout(scheduleLoad, 100);
  }
}

// -- Public wrapper functions (queue calls until Sentry loads) --

/**
 * Set user context in Sentry
 */
export function setSentryUser(user: {
  id: string;
  email?: string;
  username?: string;
  [key: string]: any;
}) {
  enqueue(() => {
    SentryModule?.setUser({
      id: user.id,
      email: user.email,
      username: user.username,
      ip_address: '{{auto}}',
    });
  });
}

/**
 * Clear user context in Sentry
 */
export function clearSentryUser() {
  enqueue(() => {
    SentryModule?.setUser(null);
  });
}

/**
 * Manually capture an exception
 */
export function captureException(error: Error, context?: Record<string, any>) {
  enqueue(() => {
    SentryModule?.captureException(error, {
      contexts: context,
    });
  });
}

/**
 * Manually capture a message
 */
export function captureMessage(message: string, level: 'info' | 'warning' | 'error' = 'info') {
  enqueue(() => {
    SentryModule?.captureMessage(message, level);
  });
}

/**
 * Add a breadcrumb for debugging context. Breadcrumbs are free: they ride
 * inside the next event and are never an event of their own.
 */
export function addBreadcrumb(breadcrumb: {
  message: string;
  category?: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, any>;
}) {
  enqueue(() => {
    SentryModule?.addBreadcrumb({
      message: breadcrumb.message,
      category: breadcrumb.category || 'custom',
      level: breadcrumb.level || 'info',
      data: breadcrumb.data,
    });
  });
}
