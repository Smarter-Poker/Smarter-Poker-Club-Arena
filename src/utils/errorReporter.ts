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
export function reportError(
  error: unknown,
  context: string,
  extra?: Record<string, any>
): void {
  // Always log to console for dev visibility
  console.error(`[${context}]`, error);

  // Send to Sentry for production alerting
  let err: Error;
  if (error instanceof Error) {
    err = error;
  } else if (typeof error === 'object' && error !== null) {
    err = new Error((error as any).message || (error as any).code || JSON.stringify(error));
  } else {
    err = new Error(String(error));
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
