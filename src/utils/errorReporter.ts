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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS FUNCTION IS ONLY EVER CALLED FROM A CATCH BLOCK, SO IT MAY NOT THROW.
 *
 * That is not a style preference, it is the whole contract. A reporter that
 * throws does not add a second error to the pile - it REPLACES the first one.
 * The caller's `catch` was handling a known failure; instead it gets an
 * unrelated TypeError from the machinery that was supposed to be writing the
 * failure down, and the thing that actually went wrong is never recorded.
 *
 * Each of the obvious spellings below has already failed in production:
 *
 *   - `err.message = x` throws on a DOMException, whose `message` is an
 *     accessor with no setter (the 2026-09-09 chapter below, and the
 *     2026-09-12 one after it);
 *   - `String(x)` throws on a Symbol, and on any object with a hostile or
 *     inherited-from-null `toString`;
 *   - `JSON.stringify(x)` throws on a circular object and on a BigInt;
 *   - reading `x.message` at all throws if `x` is a Proxy, or an object whose
 *     `message` getter itself raises.
 *
 * So every read is guarded, every conversion is guarded, and the whole body is
 * wrapped a second time as a backstop. Nothing here mutates the caller's
 * error: the caller still owns it, still shows it, still rethrows it.
 */

import { captureException, addBreadcrumb } from '../core/SentryInit';

/** `String(value)` that cannot throw — Symbols and hostile `toString`s included. */
function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '[unstringifiable value]';
  }
}

/** `JSON.stringify(value)` that cannot throw, and never returns `undefined`. */
function safeJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json : null;
  } catch {
    return null;
  }
}

/**
 * Read one property off something that may not want to be read.
 *
 * A getter can throw, and a Proxy can throw on the get trap alone, so even
 * `error.message` is a guarded operation when `error` came from outside.
 */
function safeRead(source: unknown, key: string): unknown {
  try {
    return (source as Record<string, unknown> | null | undefined)?.[key];
  } catch {
    return undefined;
  }
}

/** The same read, narrowed to a usable string. */
function safeReadString(source: unknown, key: string): string | null {
  const value = safeRead(source, key);
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Build the Error that gets reported. Always a NEW object; the caller's error
 * is only ever read.
 */
function buildReport(error: unknown, context: string): Error {
  let baseMessage: string;
  const extras: Record<string, unknown> = {};

  if (error instanceof Error) {
    baseMessage = safeReadString(error, 'message') ?? safeString(error);
  } else if (error && typeof error === 'object') {
    // Supabase errors: { message, code, details, hint }
    const obj = error as Record<string, unknown>;
    let picked: unknown;
    for (const key of ['message', 'details', 'error_description', 'error']) {
      const value = safeRead(obj, key);
      if (value) {
        picked = value;
        break;
      }
    }
    if (picked === undefined) {
      baseMessage = safeJson(obj) ?? safeString(obj);
    } else if (typeof picked === 'object') {
      baseMessage = safeJson(picked) ?? 'Circular or Un-stringifyable Object';
    } else {
      baseMessage = safeString(picked);
    }
    // Preserve extra fields as properties on the reported Error object
    for (const key of ['code', 'details', 'hint']) {
      const value = safeRead(obj, key);
      if (value !== undefined && value !== null) extras[key] = value;
    }
  } else {
    baseMessage = safeString(error);
  }

  /**
   * Guard against errors that ALREADY had an "[object Object]" message.
   *
   * THIS USED TO ASSIGN, AND ITS `catch` REPEATED THE ASSIGNMENT (2026-04-22
   * to 2026-09-12):
   *
   *     try { err.message = JSON.stringify(error); }
   *     catch (e) { err.message = 'Unknown Object Error'; }
   *
   * Both lines write the same read-only property, so on any error that
   * refuses the write the catch re-raised the identical TypeError with
   * nothing left to catch it - a recovery path that could only ever repeat
   * the failure it was recovering from. Computing a string never has that
   * problem, so the guard now computes one.
   */
  if (baseMessage === '[object Object]') {
    baseMessage = safeJson(error) ?? 'Unknown Object Error';
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
   *
   * IT WAS NOT LEFT ALONE UNTIL 2026-09-09. The paragraph above was written
   * beside `try { err.message = prefixed } catch { copy }`, which mutates
   * every error that CAN be mutated and copies only the DOMException that
   * cannot. So a caller that reported and then showed `err.message` - the
   * cash create flow does exactly that, on purpose, so a host reads the
   * server's own sentence - toasted "[CashGameCreateFlow.create_failed]
   * Failed to fetch" with the context in square brackets. Found by
   * tests/cash-games-are-created-from-a-template.law.test.tsx (must-move
   * audit, lane I). Now the copy is unconditional: Sentry gets the prefixed
   * copy with the original name and stack, the caller's object never changes.
   *
   * WHAT THE COPY DID NOT FIX, found 2026-09-12 in horse_bug_reports: the
   * `[object Object]` guard thirty lines above was still assigning, and the
   * DOMException that reaches this reporter most often is not the share
   * decoder at all. `OfflineQueueService.getCount()` let IndexedDB's
   * `InvalidStateError` out as an unhandled rejection once every two seconds,
   * main.tsx handed each one here, and the assignment threw back out of the
   * `unhandledrejection` listener - so the browser re-raised it through
   * `window.onerror` and HorseBugReporter filed it as a SECOND critical bug.
   * 2,686 rows in one 98-minute session on 2026-04-02, another 158 on
   * 2026-08-29, exactly one per rejection, and not one of the underlying
   * IndexedDB failures ever reached Sentry because the throw happened on the
   * line before `captureException`.
   */
  const reported = new Error(`[${context}] ${baseMessage}`);
  const originalName = safeReadString(error, 'name');
  if (originalName) reported.name = originalName;
  const originalStack = safeReadString(error, 'stack');
  if (originalStack) reported.stack = originalStack;
  // Safe: `reported` is a fresh Error, and none of these keys is `message`.
  for (const [key, value] of Object.entries(extras)) {
    (reported as unknown as Record<string, unknown>)[key] = value;
  }
  return reported;
}

/**
 * Report an error to both console and Sentry.
 * @param error - The error object or message string
 * @param context - A short string identifying where the error occurred (e.g. 'WalletService.lockForBuyIn')
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  try {
    // Always log to console for dev visibility
    console.error(`[${context}]`, error);

    captureException(buildReport(error, context), {
      errorContext: { source: context, ...extra },
    });
  } catch (reporterFailure) {
    /**
     * THE BACKSTOP. Nothing above is expected to throw any more, and if
     * something does it is a defect in this file - but the caller's catch
     * block is not the place to find that out. `console.warn` and not
     * `console.error`: HorseBugReporter intercepts console.error and files
     * production bug rows from it, and a reporter that files a bug about
     * itself failing to file a bug is the loop this whole file exists to end.
     */
    try {
      console.warn(
        `[errorReporter] reporting failed for ${context}:`,
        safeString(safeRead(reporterFailure, 'message') ?? reporterFailure)
      );
    } catch {
      /* there is nothing left to try */
    }
  }
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
