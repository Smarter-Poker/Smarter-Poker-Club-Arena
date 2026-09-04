/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SENTRY INITIALIZATION — Lazy-Loaded Error Tracking & Performance Monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 * Initializes Sentry.io for comprehensive error tracking, performance monitoring,
 * and session replay across the Club Arena application.
 *
 * LAZY-LOADING: the Sentry surface (src/core/sentryBundle.ts) is loaded dynamically after
 * first render via requestIdleCallback, keeping it out of the critical path.
 * All public wrapper functions safely queue or no-op until Sentry is ready.
 *
 * Features:
 * - Automatic error capture with stack traces
 * - Performance monitoring with distributed tracing
 * - Session replay for debugging user issues
 * - User identification and context
 * - Supabase integration for database monitoring
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import { reportError } from '../utils/errorReporter';
import type { SentrySurface } from './sentryBundle';

// ── Module-level state ──
let SentryModule: SentrySurface | null = null;
let initPromise: Promise<SentrySurface | null> | null = null;

// Queue of actions to replay once Sentry loads
type QueuedAction = () => void;
const pendingQueue: QueuedAction[] = [];
const MAX_QUEUE = 50; // Cap to prevent memory leaks if Sentry never loads

function enqueue(action: QueuedAction) {
  if (SentryModule) {
    // Sentry already loaded — execute immediately
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
    // Dynamic imports — react-router-dom hooks are needed for route tracking
    const [Sentry, { createRoutesFromChildren, matchRoutes, useLocation, useNavigationType }] =
      await Promise.all([import('./sentryBundle'), import('react-router-dom')]);

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

      integrations: [
        Sentry.reactRouterV6BrowserTracingIntegration({
          useEffect: React.useEffect,
          useLocation,
          useNavigationType,
          createRoutesFromChildren,
          matchRoutes,
        }),
        Sentry.replayIntegration({
          maskAllText: true,
          blockAllMedia: true,
          maskAllInputs: true,
          networkDetailAllowUrls: [
            'https://kuklfnapbkmacvwxktbh.supabase.co',
            'https://smarter.poker/api',
          ],
          networkCaptureBodies: true,
          networkRequestHeaders: ['User-Agent', 'X-Request-ID'],
          networkResponseHeaders: ['X-Response-Time'],
        }),
      ],

      tracesSampleRate: environment === 'production' ? 0.1 : 1.0,
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,

      // Only inject sentry-trace headers to our own domains (avoids CORS issues with third parties)
      tracePropagationTargets: [
        'localhost',
        /^https:\/\/kuklfnapbkmacvwxktbh\.supabase\.co/,
        /^https:\/\/smarter\.poker/,
      ],

      // Filter out noise from browser extensions and third-party scripts
      denyUrls: [
        /extensions\//i,
        /^chrome:\/\//i,
        /^moz-extension:\/\//i,
        /^safari-extension:\/\//i,
        /googletagmanager\.com/i,
        /graph\.facebook\.com/i,
      ],

      beforeSend(event, hint) {
        const error = hint.originalException as Error | undefined;

        if (error && typeof error === 'object') {
          if ('name' in error) {
            const name = String(error.name);
            if (name === 'AbortError') return null;
          }

          if ('message' in error) {
            const message = String(error.message);
            if (message.includes('Failed to fetch') || message.includes('NetworkError'))
              return null;
            if (message.includes('ResizeObserver')) return null;
            if (message.includes('signal is aborted') || message.includes('aborted')) return null;
            if (message.includes('Internal error')) return null;
            if (message.includes('Cannot read properties of null')) {
              const stack = 'stack' in error ? String(error.stack) : '';
              if (!stack.includes('/src/')) return null;
            }
          }

          if ('stack' in error) {
            const stack = String(error.stack);
            if (stack.includes('chrome-extension://') || stack.includes('moz-extension://'))
              return null;
          }
        }

        return event;
      },

      beforeSendTransaction(event) {
        if (event.start_timestamp && event.timestamp) {
          const duration = (event.timestamp - event.start_timestamp) * 1000;
          if (duration < 100) return null;
        }
        return event;
      },

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
 * Initialize Sentry error tracking and performance monitoring.
 * Now lazy-loads the Sentry surface dynamically after first render.
 * Safe to call synchronously — the actual load happens in the background.
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

// ── Public wrapper functions (queue calls until Sentry loads) ──

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
 * Add custom context to Sentry events
 */
export function setSentryContext(key: string, context: Record<string, any>) {
  enqueue(() => {
    SentryModule?.setContext(key, context);
  });
}

/**
 * Add custom tags to Sentry events
 */
export function setSentryTags(tags: Record<string, string>) {
  enqueue(() => {
    SentryModule?.setTags(tags);
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
 * Add a breadcrumb for debugging context
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

/**
 * Start a performance span
 */
export function startTransaction(name: string, op: string = 'custom') {
  // Spans only make sense if Sentry is already loaded
  if (SentryModule) {
    return SentryModule.startSpan({ name, op }, (span) => span);
  }
  return undefined;
}
