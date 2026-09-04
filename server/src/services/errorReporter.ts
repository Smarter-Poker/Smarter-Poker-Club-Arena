/**
 * ===============================================================================
 *  SERVER ERROR REPORTER - Centralized Error Capture for Game Server
 * ===============================================================================
 *
 * Server-side equivalent of the client errorReporter.
 * Wraps console.error + Sentry.captureException into a single call.
 *
 * Usage:
 *   import { reportError } from './services/errorReporter.js';
 *   try { ... } catch (err) { reportError(err, 'HandController.dealFlop'); }
 *
 * -------------------------------------------------------------------------------
 *  THE SENTRY ALLOWLIST (2026-09-04, docs/SENTRY-FREE-TIER-POLICY.md section 3)
 * -------------------------------------------------------------------------------
 * Sentry is on the free plan: 5,000 errors a month for the whole organisation,
 * of which the engine may spend 60 a day. The engine deals 33,500 hands an
 * hour; one bug that fires per hand would exhaust a MONTH in nine minutes and
 * then Sentry would silently drop the real thing for every project in the org.
 *
 * So every reportError call still writes its console line (stdout is what the
 * host captures), but only the contexts named in SENTRY_CONTEXT_ALLOWLIST go
 * on to Sentry. Everything else is counted (`suppressedReportCount`, published
 * as `poker_sentry_events_suppressed_total`) and stays local. Sentry is an
 * alarm bell for surprises on paths that move money or keep the platform
 * alive; it is not a log. The bell rings for:
 *
 *   THE PROCESS IS ABOUT TO DIE
 *     GameServer.Fatal_error (boot), GameServer.Uncaught_exception,
 *     GameServer.Unhandled_rejection, GameServer.hand_history_queue_lost_on_fatal,
 *     Supabase.FATAL (no service key at boot)
 *
 *   A HAND IN FLIGHT IS AT RISK (drain / maintenance break)
 *     GameServer.drain_timed_out, MaintenanceBreak.park_failed
 *
 *   CHIPS DID NOT MOVE AS THE ENGINE BELIEVES (settlement refused / threw)
 *     DB.settle_hand_stacks_conservation_refused, DB.settle_hand_stacks_declined,
 *     DB.settle_hand_stacks_unreachable, DB.settle_hand_stacks_unreachable_alert_failed,
 *     ServerTableEnginethistableId.AtomicSettle_failed, HandController.CRITICAL
 *     (a pot with nobody to award it to)
 *
 *   THE RECORD AND THE MONEY DISAGREE (ledger write failure)
 *     Tournament.settle_obligation_transport, ServerTableEngine.bomb_award_ledger_write_failed,
 *     ServerTableEngine.bomb_award_ledger_write_threw, GameServer.bomb_ledger_repair_failed,
 *     GameServer.bomb_ledger_repair_threw, processBBJPayout.Atomic_rpc_failed,
 *     processBBJPayout.Fatal_error, logRakeCollection.Club_chip_pool_credit_failed,
 *     logRakeCollection.Union_wallet_credit_failed, logRakeCollection.club_wallets_credit_failed,
 *     Tournament.rake_settlement_failed
 *
 *   A PLAYER IS OWED (payout / bounty / refund credit failed after retries)
 *     TournamentthistournamentIdslic.CRITICAL, TournamentthistournamentIdslic.Prize_recalc_credit_FAILED_for,
 *     Tournament.payout_reconcile_failed, Tournament.payout_reconcile_threw,
 *     Tournament.bubble_protection_credit_failed, Tournament.final_table_deal_credit_failed,
 *     Tournament.mystery_bounty_pay_failed, Tournament.mystery_bounty_settle_failed,
 *     Tournament.mystery_bounty_settle_threw, Tournament.bounty_pool_finalise_failed,
 *     TournamentthistournamentIdslic.Bounty_processing_error, Tournament.spin_settle_failed,
 *     GameServer.backed_payout_failed, GameServer.backed_payout_threw,
 *     GameServer.cancel_refund_failed, GameServer.cancel_refund_fee_reversal_failed,
 *     FeeReconciler.prize_disbursement, FeeReconciler.prize_disbursement_threw,
 *     RakebackSettler.tournament_payout_unreconciled
 *
 *   THE ESTATE HAS STOPPED DEALING
 *     DealRateVerifier.fleet_silent
 *
 * Every string above is the literal at its call site (grep it; do not guess).
 * Adding one is a pull request that names the daily cost. The gate lives here,
 * in the wrapper, because the ~700 call sites are a diff nobody can review and
 * the one place every call passes through is the right place to decide.
 *
 * What is NOT here and where it went: seat heartbeats, RPC retries that
 * succeeded, horse logic, voice ICE, discovery loops - Prometheus gauges and
 * the alert groups in infra/monitoring/alert-rules.yml (`settlement`,
 * `money-health`, `replication`, `cron-health`); money-shaped failures also
 * raise `financial_alerts` rows through services/financialAlerts.ts.
 */

import * as Sentry from '@sentry/node';
import { SentryEventBudget, budgetFromEnv, fingerprintOf } from './sentryEventBudget.js';

export const SENTRY_CONTEXT_ALLOWLIST: ReadonlySet<string> = new Set([
  // The process is about to die
  'GameServer.Fatal_error',
  'GameServer.Uncaught_exception',
  'GameServer.Unhandled_rejection',
  'GameServer.hand_history_queue_lost_on_fatal',
  'Supabase.FATAL',
  // A hand in flight is at risk
  'GameServer.drain_timed_out',
  'MaintenanceBreak.park_failed',
  // Settlement refused / threw
  'DB.settle_hand_stacks_conservation_refused',
  'DB.settle_hand_stacks_declined',
  'DB.settle_hand_stacks_unreachable',
  'DB.settle_hand_stacks_unreachable_alert_failed',
  'ServerTableEnginethistableId.AtomicSettle_failed',
  'HandController.CRITICAL',
  // Ledger write failure
  'Tournament.settle_obligation_transport',
  'ServerTableEngine.bomb_award_ledger_write_failed',
  'ServerTableEngine.bomb_award_ledger_write_threw',
  'GameServer.bomb_ledger_repair_failed',
  'GameServer.bomb_ledger_repair_threw',
  'processBBJPayout.Atomic_rpc_failed',
  'processBBJPayout.Fatal_error',
  'logRakeCollection.Club_chip_pool_credit_failed',
  'logRakeCollection.Union_wallet_credit_failed',
  'logRakeCollection.club_wallets_credit_failed',
  'Tournament.rake_settlement_failed',
  // A player is owed
  'TournamentthistournamentIdslic.CRITICAL',
  'TournamentthistournamentIdslic.Prize_recalc_credit_FAILED_for',
  'Tournament.payout_reconcile_failed',
  'Tournament.payout_reconcile_threw',
  'Tournament.bubble_protection_credit_failed',
  'Tournament.final_table_deal_credit_failed',
  'Tournament.mystery_bounty_pay_failed',
  'Tournament.mystery_bounty_settle_failed',
  'Tournament.mystery_bounty_settle_threw',
  'Tournament.bounty_pool_finalise_failed',
  'TournamentthistournamentIdslic.Bounty_processing_error',
  'Tournament.spin_settle_failed',
  'GameServer.backed_payout_failed',
  'GameServer.backed_payout_threw',
  'GameServer.cancel_refund_failed',
  'GameServer.cancel_refund_fee_reversal_failed',
  'FeeReconciler.prize_disbursement',
  'FeeReconciler.prize_disbursement_threw',
  'RakebackSettler.tournament_payout_unreconciled',
  // The estate has stopped dealing
  'DealRateVerifier.fleet_silent',
]);

/** True when a reportError with this context may reach Sentry. */
export function isSentryAllowedContext(context: string): boolean {
  return SENTRY_CONTEXT_ALLOWLIST.has(context);
}

// ===============================================================================
// SENTRY INITIALIZATION
// ===============================================================================

/**
 * Supabase/PostgREST connectivity failures. These are transient, but they are
 * ALSO the direct cause of table freezes (a stalled dealing-loop await), so
 * they are rate-limited to one report per message per minute rather than
 * dropped entirely - silencing them is what made the 2026-08-15 incident
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
 * The daily event budget: 60 a day, 3 per fingerprint, UTC reset. See
 * sentryEventBudget.ts. Its counters are what /metrics publishes.
 */
export const budget = new SentryEventBudget(budgetFromEnv());

/** Reports kept local by the allowlist since boot. Published on /metrics. */
let suppressedReportCount = 0;

/**
 * The numbers GameServer.getPrometheusMetrics() reads. Synchronous, no I/O.
 *   sentToday       - events that passed beforeSend today (UTC)
 *   droppedTotal    - events the budget refused since boot (monotonic)
 *   droppedToday    - the same, today only
 *   suppressedTotal - reportError calls whose context was not allowlisted
 */
export function sentryBudgetSnapshot(): {
  sentToday: number;
  droppedTotal: number;
  droppedToday: number;
  suppressedTotal: number;
  day: string;
} {
  return {
    sentToday: budget.sentToday,
    droppedTotal: budget.dropped,
    droppedToday: budget.droppedToday,
    suppressedTotal: suppressedReportCount,
    day: budget.currentDay,
  };
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
      // Errors only. Tracing is OFF on the free plan (5M spans a month is six
      // days of per-hand tracing); action latency is on /metrics as
      // poker_action_processing_p95_ms instead. Profiling needs
      // @sentry/profiling-node, which is not installed, and cannot run with
      // tracing at 0 anyway - there is no profilesSampleRate to set.
      tracesSampleRate: 0,

      // Server-specific integrations
      integrations: [
        Sentry.onUncaughtExceptionIntegration(),
        Sentry.onUnhandledRejectionIntegration(),
      ],

      // Filter out noise - transient network errors + Supabase connectivity blips
      beforeSend(event, hint) {
        const error = hint.originalException as Error | undefined;
        const msg = error?.message ?? '';
        // 2026-08-15: this filter used to drop EVERY Supabase connectivity
        // error. The freeze incident that day was caused by exactly that error
        // class - a degrading transport stalling the dealing loop - and Sentry
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

        // The daily budget: 3 per fingerprint, 60 global, UTC reset. Uncaught
        // exceptions and unhandled rejections arrive here too (the SDK's own
        // integrations, no reportError context), so the fingerprint falls back
        // to the message head - a crash loop that re-throws the same error is
        // still one key.
        const eventMessage = msg || event.message || event.exception?.values?.[0]?.value || '';
        const source = (event.contexts?.errorContext as { source?: string } | undefined)?.source;
        const verdict = budget.admit(fingerprintOf(eventMessage, source));
        if (!verdict.allow) return null;
        event.tags = {
          ...event.tags,
          sentry_budget_sent_today: String(verdict.sentToday),
          ...(verdict.droppedForKey > 0
            ? { budget_dropped_before_this: String(verdict.droppedForKey) }
            : {}),
        };
        return event;
      },
    });

    initialized = true;
    console.log('[Sentry:Server] Initialized for game server error tracking (errors only, 60/day)');
  } catch (err) {
    console.error('[Sentry:Server] Initialization failed:', err);
  }
}

// ===============================================================================
// REPORT ERROR - console always; Sentry only for allowlisted contexts
// ===============================================================================

/**
 * Report an error to the console and, when the context is allowlisted, to Sentry.
 * @param error - The error object, message string, or any value
 * @param context - A short string identifying where the error occurred
 * @param extra - Optional additional data to attach to the Sentry event
 */
export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  // Always log to console for stdout/stderr visibility
  console.error(`[${context}]`, error);

  if (!isSentryAllowedContext(context)) {
    suppressedReportCount += 1;
    return;
  }

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
 * Flush Sentry events before process exit.
 * Call this in shutdown handlers.
 */
export async function flushSentry(timeout = 5000): Promise<void> {
  if (!initialized) return;
  try {
    const snap = sentryBudgetSnapshot();
    if (snap.droppedTotal > 0 || snap.suppressedTotal > 0) {
      console.warn(
        `[Sentry:Server] at shutdown: ${snap.sentToday} sent today, ${snap.droppedTotal} dropped by budget, ` +
          `${snap.suppressedTotal} kept local by the allowlist`
      );
    }
    await Sentry.flush(timeout);
  } catch {
    // Silent
  }
}
