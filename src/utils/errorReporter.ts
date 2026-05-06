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
 * Report an error to both console and Sentry.
 * @param error - The error object or message string
 * @param context - A short string identifying where the error occurred (e.g. 'WalletService.lockForBuyIn')
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  // Always log to console for dev visibility
  console.error(`[${context}]`, error);

  // Coerce any non-Error (e.g. Supabase {message, code} plain objects) into real Errors
  // so Sentry gets a useful message instead of "[object Object]"
  let err: Error;
  if (error instanceof Error) {
    err = error;
  } else if (error && typeof error === 'object') {
    // Supabase errors: { message, code, details, hint }
    const obj = error as Record<string, unknown>;
    let msg =
      obj.message || obj.details || obj.error_description || obj.error || JSON.stringify(obj);
    if (typeof msg === 'object') {
      try {
        msg = JSON.stringify(msg);
      } catch (e) {
        msg = 'Circular or Un-stringifyable Object';
      }
    }
    err = new Error(String(msg));
    // Preserve extra fields as properties on the Error object
    if (obj.code) (err as any).code = obj.code;
    if (obj.details) (err as any).details = obj.details;
    if (obj.hint) (err as any).hint = obj.hint;
  } else {
    err = new Error(String(error));
  }

  // Guard against errors that ALREADY had an "[object Object]" message
  if (err.message === '[object Object]') {
    try {
      err.message = JSON.stringify(error);
    } catch (e) {
      err.message = 'Unknown Object Error';
    }
  }

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
