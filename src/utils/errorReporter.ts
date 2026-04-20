/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ERROR REPORTER — Centralized Error Capture Utility
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Wraps console.error + Sentry.captureException into a single call.
 * Use this in service-level and page-level catch blocks for production
 * visibility into errors that would otherwise be silently swallowed.
 *
 * Usage:
 *   import { reportError } from '../utils/errorReporter';
 *   try { ... } catch (err) { reportError(err, 'WalletService.lockForBuyIn'); }
 */

import { captureException, addBreadcrumb } from '../core/SentryInit';

/**
 * Convert an unknown error value to a readable string.
 * Handles Error instances, plain objects (e.g. Supabase PostgrestError), and primitives.
 */
function errorToString(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    // Supabase errors are plain objects with a `message` property
    if ('message' in error && typeof (error as any).message === 'string') {
      return (error as any).message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Report an error to both console and Sentry.
 * @param error - The error object or message string
 * @param context - A short string identifying where the error occurred (e.g. 'WalletService.lockForBuyIn')
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(
  error: unknown,
  context: string,
  extra?: Record<string, any>
): void {
  // Always log to console for dev visibility
  console.error(`[${context}]`, error);

  // Send to Sentry for production alerting
  const err = error instanceof Error ? error : new Error(errorToString(error));
  err.message = `[${context}] ${err.message}`;

  captureException(err, {
    errorContext: { source: context, ...extra },
  });
}

/**
 * Report a warning-level issue (non-fatal but noteworthy).
 * Appears in Sentry breadcrumbs for debugging context.
 */
export function reportWarning(message: string, context: string, data?: Record<string, any>): void {
  console.warn(`[${context}] ${message}`);
  addBreadcrumb({
    message: `[${context}] ${message}`,
    category: 'warning',
    level: 'warning',
    data,
  });
}
