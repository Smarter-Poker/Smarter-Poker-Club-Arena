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
import { SentryEventBudget, budgetFromEnv, fingerprintOf } from './sentryEventBudget.js';

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

/**
 * 2026-09-04: the event budget. Per-fingerprint and global caps on what the
 * engine may send per minute, with a periodic summary of what was dropped.
 * The August error loops burned the whole org quota and blinded every other
 * project for three weeks; Sentry's own key rate limit is not available on
 * this plan, so this is the guard. See sentryEventBudget.ts for the design.
 */
const budget = new SentryEventBudget(budgetFromEnv());
const BUDGET_SUMMARY_TAG = 'sentry_budget_summary';
const BUDGET_SUMMARY_INTERVAL_MS = 10 * 60_000;
let summaryTimer: NodeJS.Timeout | null = null;

/** Send ONE event describing what the budget dropped since the last summary. */
export function flushBudgetSummary(): boolean {
  const summary = budget.drainSummary();
  if (!summary) return false;
  const top = summary.byKey.slice(0, 15);
  const lines = top.map((r) => `${r.dropped} x ${r.key}`).join('\n');
  console.warn(
    `[Sentry:Server] budget dropped ${summary.total} event(s) since last summary:\n${lines}`
  );
  try {
    Sentry.captureMessage(
      `[SentryBudget] dropped ${summary.total} engine event(s) in the last ${BUDGET_SUMMARY_INTERVAL_MS / 60_000} min`,
      {
        level: 'warning',
        tags: { [BUDGET_SUMMARY_TAG]: 'true', server: 'game-engine', component: 'SentryBudget' },
        contexts: { sentryBudget: { total: summary.total, top, distinct: summary.byKey.length } },
        // One issue per engine, not one per interval: group every summary together.
        fingerprint: ['sentry-budget-summary'],
      }
    );
  } catch {
    // Never let the summary crash the engine
  }
  return true;
}

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

        // The budget summary is the one event that must always get through:
        // it is how a throttled engine reports that it was throttled.
        if (event.tags?.[BUDGET_SUMMARY_TAG] === 'true') return event;

        // Budget: per-fingerprint + global caps. Uncaught exceptions and
        // unhandled rejections arrive here too (no reportError context), so the
        // fingerprint falls back to the message head - a crash loop that
        // re-throws the same error is still one key.
        const eventMessage = msg || event.message || event.exception?.values?.[0]?.value || '';
        const source = (event.contexts?.errorContext as { source?: string } | undefined)?.source;
        const verdict = budget.admit(fingerprintOf(eventMessage, source));
        if (!verdict.allow) return null;
        if (verdict.droppedForKey > 0) {
          event.tags = { ...event.tags, budget_dropped_before_this: String(verdict.droppedForKey) };
        }
        return event;
      },
    });

    initialized = true;
    if (!summaryTimer) {
      summaryTimer = setInterval(flushBudgetSummary, BUDGET_SUMMARY_INTERVAL_MS);
      summaryTimer.unref?.();
    }
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
/**
 * Describe ANY thrown value as readable text.
 *
 * `String(err)` renders every non-Error object as the literal string
 * "[object Object]". Supabase rejects with a PostgrestError - a plain object,
 * never an Error instance - so every money path that reported an error with
 * `err instanceof Error ? err.message : String(err)` recorded the four words
 * "[object Object]" and threw the diagnosis away.
 *
 * Measured 2026-09-08/09: 1,058 CRITICAL `financial_alerts` rows for
 * `ServerTableEngine.post_commit_obligations_pending`, every one of them
 * carrying `"error": "[object Object]"`. The incident dashboard classified
 * all of them `unknown` because there was nothing left to classify. Nobody
 * could act on them, so nobody did.
 *
 * Same precedence `reportError` already applies below, extracted so the alert
 * paths can share it: message, then the Supabase/GoTrue detail fields, then
 * JSON, and a PostgREST code when one is present.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    const e = error as Record<string, any>;
    const head = e.message || e.error_description || e.details || e.hint || e.error || null;
    const code = e.code ? ` (${e.code})` : '';
    if (head) return `${String(head)}${code}`;
    try {
      return `${JSON.stringify(error)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

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
    // A restart must not lose the drop counts: emit the summary first.
    flushBudgetSummary();
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
