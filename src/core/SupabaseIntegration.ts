/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SUPABASE SENTRY INTEGRATION
 * ═══════════════════════════════════════════════════════════════════════════════
 * Custom Sentry integration for monitoring Supabase database operations.
 * Tracks query performance, errors, and RLS policy violations.
 *
 * Uses lazy-loaded Sentry via SentryInit wrappers — no static @sentry/react
 * import, keeping this module out of the critical bundle path.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { getSentry, getSentryAsync, captureException as sentryCapture } from './SentryInit';

/**
 * Track a Supabase operation with Sentry
 */
export function trackSupabaseOperation<T>(
  table: string,
  operation: string,
  promise: Promise<T>
): Promise<T> {
  const Sentry = getSentry();

  // If Sentry isn't loaded yet, just pass through the promise without wrapping
  if (!Sentry) {
    return promise
      .then(async (result) => {
        // Still check for errors even without span tracking
        await reportSupabaseErrors(result, table, operation);
        return result;
      })
      .catch(async (error) => {
        sentryCapture(error instanceof Error ? error : new Error(String(error)));
        throw error;
      });
  }

  return Sentry.startSpan(
    {
      name: `Supabase ${operation}`,
      op: 'db.query',
      attributes: {
        'db.table': table,
        'db.operation': operation,
      },
    },
    async () => {
      try {
        const result = await promise;
        await reportSupabaseErrors(result, table, operation);
        return result;
      } catch (error) {
        Sentry.captureException(error, {
          tags: { table, operation },
        });
        throw error;
      }
    }
  );
}

/**
 * Check Supabase result for errors and report to Sentry
 */
async function reportSupabaseErrors<T>(result: T, table: string, operation: string) {
  if (result && typeof result === 'object' && 'error' in result) {
    const error = (result as any).error;
    if (!error) return;

    // Load Sentry async for error reporting (non-blocking)
    const Sentry = await getSentryAsync();
    if (!Sentry) return;

    Sentry.captureException(error, {
      tags: {
        table,
        operation,
        error_code: error.code,
      },
      contexts: {
        supabase: {
          table,
          operation,
          error_code: error.code,
          error_message: error.message,
          error_details: error.details,
          error_hint: error.hint,
        },
      },
    });

    // Check for RLS policy violations
    if (error.code === 'PGRST301' || error.code === '42501') {
      Sentry.captureMessage(`RLS Policy Violation: ${table}`, {
        level: 'warning',
        tags: {
          table,
          error_type: 'rls_policy_violation',
        },
      });
    }
  }
}

/**
 * Helper to wrap Supabase queries with Sentry tracking
 */
export async function trackSupabaseQuery<T>(
  table: string,
  operation: string,
  query: PromiseLike<T>
): Promise<T> {
  return trackSupabaseOperation(table, operation, Promise.resolve(query));
}
