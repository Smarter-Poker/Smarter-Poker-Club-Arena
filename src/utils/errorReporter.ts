/**
 * ===============================================================================
 *  ERROR REPORTER - Centralized Error Capture Utility
 * ===============================================================================
 *
 * Wraps console.error + Sentry.captureException into a single call.
 * Use this in service-level and page-level catch blocks.
 *
 * Usage:
 *   import { reportError } from '../utils/errorReporter';
 *   try { ... } catch (err) { reportError(err, 'WalletService.lockForBuyIn'); }
 *
 * -------------------------------------------------------------------------------
 *  THE SENTRY ALLOWLIST (2026-09-04, docs/SENTRY-FREE-TIER-POLICY.md section 3)
 * -------------------------------------------------------------------------------
 * Sentry is on the free plan: 5,000 errors a month for the whole organisation,
 * of which this client may spend 40 a day. There are ~1,300 reportError call
 * sites in src/. They all keep working - every one still writes the console
 * line it always did - but only the contexts named in SENTRY_CONTEXT_ALLOWLIST
 * below go on to Sentry. Anything else is a console.warn saying so, once per
 * context per page load, and nothing leaves the browser.
 *
 * Sentry is an alarm bell for surprises on paths that move money or show a
 * player a crash. It is not a log. The allowlist is therefore:
 *
 *   BOUNDARIES - a player saw a crash
 *     PageErrorBoundary.crash, RouteErrorBoundary.crash, TableErrorBoundary.crash
 *     (the root ErrorBoundary captures directly, for its report-dialog event id,
 *     and is budgeted by the same beforeSend), plus the two in-page boundaries
 *     HomePage.HomePage_ErrorBoundary and ClubDetailPage.CardErrorBoundary...
 *
 *   THE GLOBAL NET - the app is in a state nobody wrote a handler for
 *     main.Unhandled_promise_rejection_caught (Sentry's own onerror hook covers
 *     uncaught exceptions; it has no context and is budgeted by beforeSend),
 *     main.Missing_environment_variables__rendering (a broken build booted).
 *
 *   MONEY - the client believes a chip movement happened, or asked for one,
 *   and the server refused or never answered
 *     buy-in, cash-out, rebuy/add-on, transfer, payout and bonus credit paths.
 *
 * Adding a context is a pull request that names the daily cost. Take the
 * literal string from the call site; do not guess it. The gate lives here, in
 * the wrapper, because a 1,300-site diff is a diff nobody can review, and the
 * one place every call passes through is the right place to decide.
 */

import { captureException, addBreadcrumb } from '../core/SentryInit';

export const SENTRY_CONTEXT_ALLOWLIST: ReadonlySet<string> = new Set([
  // Boundaries
  'PageErrorBoundary.crash',
  'RouteErrorBoundary.crash',
  'TableErrorBoundary.crash',
  'HomePage.HomePage_ErrorBoundary',
  'ClubDetailPage.CardErrorBoundarythispropslabel__unknown',
  // The global net
  'main.Unhandled_promise_rejection_caught',
  'main.Missing_environment_variables__rendering',
  // Money: buy-in / seat
  'TablePage.atomic_table_buyin_FAILED',
  'TablePage.atomic_table_buyin_returned_failure',
  'TablePage.Buyin_FAILED',
  'WalletService.lockForBuyIn',
  'useWalletStore.Lock_for_buyin_failed',
  // Money: cash-out
  'TableService.atomicCashout',
  'TablePage.Ev_cashout_failed',
  'CashoutService.approveCashout',
  'CashoutService.sendChipsToPlayer',
  // Money: tournament rebuy / add-on
  'TournamentService.Rebuy_RPC_failed_No_chips_were_deducted',
  'TournamentService.Addon_process_failed_No_chips_were_deduc',
  // Money: transfers
  'useWalletStore.Internal_transfer_failed',
  'ChipFlowService.transfer',
  'WalletCashierModal.send',
  'PlayerWalletPage.handleTransfer',
  // Money: payouts and credits
  'SettlementPage.Payout_failed',
  'useUnionStore.Execute_payouts_failed',
  'PromotionService.Deposit_bonus_credit_failed',
  'PromotionService.Referral_bonus_credit_failed',
]);

/** True when a reportError with this context may reach Sentry. */
export function isSentryAllowedContext(context: string): boolean {
  return SENTRY_CONTEXT_ALLOWLIST.has(context);
}

/** Contexts already told, this page load, that they are console-only. */
const quietedContexts = new Set<string>();

/** Count of reports kept local by the allowlist this page load (tests). */
let suppressedCount = 0;
export function getSuppressedReportCount(): number {
  return suppressedCount;
}
export function _resetSuppressedForTests(): void {
  suppressedCount = 0;
  quietedContexts.clear();
}

/**
 * Report an error to the console and, when the context is allowlisted, to Sentry.
 * @param error - The error object or message string
 * @param context - A short string identifying where the error occurred (e.g. 'WalletService.lockForBuyIn')
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  // Always log to console for dev visibility
  console.error(`[${context}]`, error);

  if (!isSentryAllowedContext(context)) {
    suppressedCount += 1;
    if (!quietedContexts.has(context)) {
      quietedContexts.add(context);
      console.warn(
        `[errorReporter] ${context} is not on the Sentry allowlist; kept local (see docs/SENTRY-FREE-TIER-POLICY.md)`
      );
    }
    return;
  }

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
 * Appears in Sentry breadcrumbs for debugging context. A breadcrumb is not an
 * event: it costs nothing until an allowlisted error carries it along.
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
