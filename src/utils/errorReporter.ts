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

  /**
   * PREFIXING USED TO BE AN ASSIGNMENT, AND SOME ERRORS REFUSE ONE.
   *
   * `DOMException.message` is an accessor with no setter, and a DOMException
   * IS an `instanceof Error`, so it reached this line as `err` and
   * `err.message = ...` threw `TypeError: Cannot set property message of
   * which has only a getter`. The throw happens INSIDE the reporter, which is
   * only ever called from a catch block - so a handler that was being careful
   * about a failure got a second, different failure thrown back out of it,
   * and the original error was never reported at all.
   *
   * Every DOMException on the platform is in that class: `atob` on a
   * truncated share link, a storage quota, an aborted fetch, clipboard,
   * IndexedDB, Web Crypto. Found 2026-09-05 by decoding a corrupt share
   * payload, which is exactly the case the decoder has a catch for.
   *
   * Copy rather than mutate. The reported error carries the context in its
   * message either way; the caller's error object is left alone, which it
   * should have been from the start.
   */
  let reported = err;
  const prefixed = `[${context}] ${err.message}`;
  try {
    err.message = prefixed;
  } catch {
    reported = new Error(prefixed);
    reported.name = err.name;
    reported.stack = err.stack;
  }

  captureException(reported, {
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
