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

let initialized = false;

export function initSentry(): void {
  if (initialized) return;

  const dsn = process.env.SENTRY_DSN || process.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.warn('[Sentry:Server] No SENTRY_DSN configured — errors will be console-only');
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
        // Standard Node.js network transients
        if (msg.includes('ECONNRESET')) return null;
        if (msg.includes('EPIPE')) return null;
        if (msg.includes('socket hang up')) return null;
        // Supabase/PostgREST connectivity errors — fired when the Supabase API
        // gateway is temporarily unreachable or the connection is unauthenticated
        // at the HTTP level (e.g. "Project not specified" from PostgREST).
        // These are transient infrastructure blips, not code bugs.
        if (msg.includes('Project not specified')) return null;
        if (msg.includes('FetchError') && msg.includes('supabase')) return null;
        if (msg.includes('Failed to fetch') && msg.includes('supabase')) return null;
        if (msg.includes('ETIMEDOUT') && msg.includes('supabase')) return null;
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
    const err = error instanceof Error ? error : new Error(String(error));
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
