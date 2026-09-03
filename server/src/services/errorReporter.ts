/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVER ERROR REPORTER — Centralized Error Capture for Game Server
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Server-side equivalent of the client errorReporter.
 * Wraps console.error + Sentry.captureException into a single call.
 *
 * Usage:
 *   import { reportError } from './services/errorReporter.js';
 *   try { ... } catch (err) { reportError(err, 'HandController.dealFlop'); }
 */

import * as Sentry from '@sentry/node';

// ═══════════════════════════════════════════════════════════════════════════════
// SENTRY INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Supabase/PostgREST connectivity failures. These are transient, but they are
 * ALSO the direct cause of table freezes (a stalled dealing-loop await), so
 * they are rate-limited to one report per message per minute rather than
 * dropped entirely — silencing them is what made the 2026-08-15 incident
 * invisible to monitoring.
 */
const SUPABASE_TRANSIENT = [
  'ECONNRESET',
  'socket hang up',
  'Project not specified',
  'FetchError',
  'Failed to fetch',
  'fetch failed',
  'ETIMEDOUT',
  'ENOTFOUND',
  'supabase_timeout',
  'schema cache',
];
const transientLastSeen = new Map<string, number>();

let initialized = false;

export function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.warn('[Sentry:Server] No SENTRY_DSN configured - errors will be console-only');
    return;
  }

  try {
    Sentry.init({
      dsn,
      environment: process.env.NODE_ENV || 'production',
      release: `game-server@${process.env.npm_package_version || '1.0.0'}`,
      tracesSampleRate: 0.2,

      // Server-specific integrations
      integrations: [
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration(),
      ],

      // Filter out noise — transient network errors + Supabase connectivity blips
      beforeSend(event, hint) {
        const error = hint.originalException as Error | undefined;
        const msg = error?.message ?? '';
        // 2026-08-15: this filter used to drop EVERY Supabase connectivity
        // error. The freeze incident that day was caused by exactly that error
        // class — a degrading transport stalling the dealing loop — and Sentry
        // showed nothing throughout, which is why it was found by a player
        // hours later.
        //
        // Only genuinely uninteresting local-pipe noise is dropped now.
        // Supabase failures are rate-limited rather than hidden, so they stay
        // visible without flooding: one report per distinct message per minute.
        if (msg.includes('EPIPE')) return null;
        if (SUPABASE_TRANSIENT.some((m) => msg.includes(m))) {
          const now = Date.now();
          const key = msg.slice(0, 80);
          const last = transientLastSeen.get(key) ?? 0;
          if (now - last < 60_000) return null;
          transientLastSeen.set(key, now);
          if (transientLastSeen.size > 200) transientLastSeen.clear();
          event.level = 'warning';
        }
        return event;
      },
    });

    initialized = true;
    console.log('[Sentry:Server] ✅ Initialized for game server error tracking');
  } catch (err) {
    console.error('[Sentry:Server] Initialization failed:', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT ERROR — Dual-log to console + Sentry
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Report an error to both console and Sentry.
 * @param error - The error object, message string, or any value
 * @param context - A short string identifying where the error occurred
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  // Always log to console for stdout/stderr visibility
  console.error(`[${context}]`, error);

  // Send to Sentry if initialized
  if (!initialized) return;

  try {
    let err: Error;
    if (error instanceof Error) {
      err = error;
    } else if (typeof error === 'object' && error !== null) {
      const msg =
        (error as any).message ||
        (error as any).error_description ||
        (error as any).details ||
        JSON.stringify(error);
      err = new Error(msg);
    } else {
      err = new Error(String(error));
    }

    // Truncate massive HTML error payloads
    if (err.message.includes('<!DOCTYPE html>')) {
      err.message = err.message.substring(0, 200) + '... [Supabase HTML Error Truncated]';
    }

    err.message = `[${context}] ${err.message}`;

    Sentry.captureException(err, {
      contexts: {
        errorContext: { source: context, ...extra },
      },
      tags: {
        component: context.split('.')[0] || 'GameServer',
        server: 'game-engine',
      },
    });
  } catch {
    // Never let Sentry reporting crash the game server
  }
}

/**
 * Report a warning-level issue (non-fatal but noteworthy).
 */
export function reportWarning(message: string, context: string, data?: Record<string, any>): void {
  console.warn(`[${context}] ${message}`);

  if (!initialized) return;

  try {
    Sentry.addBreadcrumb({
      message: `[${context}] ${message}`,
      category: 'warning',
      level: 'warning',
      data,
    });
  } catch {
    // Silent
  }
}

/**
 * Flush Sentry events before process exit.
 * Call this in shutdown handlers.
 */
export async function flushSentry(timeout = 5000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeout);
  } catch {
    // Silent
  }
}

/**
 * Set server context tags (e.g. active tables count, uptime)
 */
export function setServerContext(data: Record<string, any>): void {
  if (!initialized) return;
  try {
    Sentry.setContext('game_server', data);
  } catch {
    // Silent
  }
}
