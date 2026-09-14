/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HORSE BUG REPORTER — Mini-Agent Automated QA System
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Horses act as automated QA mini-agents during gameplay. As they play hands
 * across all cash games and tournaments, they detect, capture, and report:
 *
 * - Runtime errors (uncaught exceptions, promise rejections)
 * - Gameplay anomalies (impossible chip amounts, negative stacks, NaN values)
 * - UI rendering failures (missing cards, broken avatars, display glitches)
 * - Action handler failures (raise rejected, fold when not needed, timeouts)
 * - Pot calculation mismatches (expected vs actual pot)
 * - Wallet sync failures (debit without credit, balance mismatches)
 * - Tournament lifecycle bugs (registration failures, blind level skips)
 * - Supabase RPC errors (function not found, permission denied)
 *
 * Reports are stored in-memory + persisted to Supabase `horse_bug_reports` table.
 * A dashboard component displays live bug reports for the admin.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type BugSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type BugCategory =
  | 'runtime_error'
  | 'gameplay_anomaly'
  | 'ui_render'
  | 'action_failure'
  | 'pot_mismatch'
  | 'wallet_sync'
  | 'tournament_bug'
  | 'rpc_error'
  | 'chip_integrity'
  | 'state_desync'
  | 'performance'
  | 'missing_data';

export interface BugReport {
  id: string;
  timestamp: string;
  horseName: string;
  horseId: string;
  tableId: string;
  tableName: string;
  handNumber: number;
  category: BugCategory;
  severity: BugSeverity;
  title: string;
  description: string;
  context: Record<string, any>;
  stackTrace?: string;
  resolved: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINGERPRINTING AND ROUTING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One database row per open bug, not one per occurrence.
 *
 * Between 2026-09-02 and 2026-09-12 this table took 243 rows that were all the
 * same bug: the production route E2E visited /table/demo and
 * /table/nonexistent-table-id on every deploy, the ticker put that raw path
 * segment into a uuid column, Postgres answered 22P02, and every single one
 * was filed as a new unresolved report. The dedupe that was supposed to stop
 * it compared raw titles inside a 5-second window held in ONE page session -
 * and every E2E run is a fresh browser context about half an hour apart, so it
 * was structurally incapable of firing. A guard scoped more narrowly than the
 * thing it guards is not a guard.
 *
 * The fix is to make the dedupe PERSISTED rather than longer: a fingerprint
 * over (context label + message with its variable literals stripped) becomes a
 * deterministic primary key, so the second occurrence updates the first row
 * instead of adding one. `demo` and `nonexistent-table-id` differ only in that
 * stripped literal, so they collapse to a single row rather than two.
 */
const UUID_LITERAL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g;

/**
 * Split `[Context.label] the rest` into its two halves.
 *
 * `reportError` writes `console.error('[' + context + ']', error)`, so the
 * component's own NAME is the first thing in every captured message. That is
 * the whole reason the categoriser below takes the body and not the message.
 */
export function splitContextLabel(msg: string): { label: string; body: string } {
  const m = /^\s*\[([^\]\n]{1,160})\]\s*([\s\S]*)$/.exec(msg);
  return m ? { label: m[1], body: m[2] } : { label: '', body: msg };
}

/**
 * Strip the parts of a message that vary between two occurrences of ONE bug.
 *
 * What is removed: uuids, ISO timestamps, standalone digit runs, and quoted
 * literals. What is deliberately KEPT: plain double-quoted runs, because in a
 * JSON-stringified Supabase error those carry the signal - `"code":"22P02"`
 * and the message text itself. Only the backslash-escaped inner literal
 * (`\"demo\"`, which is how JSON.stringify renders the value Postgres is
 * complaining about) and single-quoted literals are variable. Collapsing every
 * quoted run instead would fold two genuinely different errors from the same
 * call site onto one row, and the second would never be seen.
 */
export function normaliseBugMessage(body: string): string {
  return body
    .replace(UUID_LITERAL, '<uuid>')
    .replace(ISO_TIMESTAMP, '<ts>')
    .replace(/\\"[^"\\]*\\"/g, '\\"<v>\\"')
    .replace(/'[^'\n]*'/g, "'<v>'")
    .replace(/(^|[^A-Za-z0-9])\d{2,}(?![A-Za-z0-9])/g, '$1<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The browser has ALREADY said "Uncaught". Saying it again is a second bug.
 *
 * `window.onerror` hands over `event.message` pre-formatted, and the format is
 * the browser's, not ours: Chrome sends `Uncaught TypeError: ...` and WebKit
 * sends a bare `TypeError: ...`. Prefixing that with `Uncaught Error: ` gave
 * the operator dashboard titles reading
 *
 *   Uncaught Error: Uncaught TypeError: Cannot set property message of  which
 *   has only a getter
 *
 * - 2,686 rows of it - while the SAME defect seen in Safari five months later
 * filed under `Uncaught Error: TypeError: Attempted to assign to readonly
 * property.` and took another 158 rows of its own. One defect, two titles,
 * both misspelt, and (since #4398 made the title the fingerprint) two
 * permanently separate rows that no dedupe could ever collapse.
 *
 * Stripping the browser's own prefix leaves one shape for both engines. The
 * engines still word their messages differently, which no code here can fix,
 * but the doubling and the disagreement in OUR half of the string are gone.
 */
export function uncaughtTitle(message: unknown): string {
  const raw = typeof message === 'string' ? message : '';
  const stripped = raw.replace(/^\s*Uncaught\s+/i, '').trim();
  return `Uncaught Error: ${stripped || 'Unknown Error'}`;
}

/** Read a property off a rejection reason that may refuse to be read. */
function safeReason(reason: unknown, key: string): string | undefined {
  try {
    const value = (reason as Record<string, unknown> | null | undefined)?.[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `String(reason)` that cannot throw — a rejection reason can be anything. */
function safeReasonString(reason: unknown): string {
  try {
    return String(reason);
  } catch {
    return '[unstringifiable rejection reason]';
  }
}

/** The stable identity of a bug: where it happened, and what happened. */
export function bugFingerprint(msg: string): string {
  const { label, body } = splitContextLabel(msg);
  return `${label}|${normaliseBugMessage(body)}`.slice(0, 400);
}

/** cyrb53 - 53 bits, no dependencies, stable across sessions and platforms. */
export function stableHash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Route a console error to a category and severity BY WHAT WENT WRONG.
 *
 * THE BUG THIS REPLACES. The previous version tested the whole captured
 * message, and `reportError` puts the CONTEXT LABEL at the front of it. So a
 * client-side uuid defect in a component called TournamentStartingTicker
 * matched `msg.includes('Tournament')` and arrived in the operator's dashboard
 * as a `tournament_bug` - a money-shaped category - purely because of where it
 * was raised. Every label works this way: anything named *Wallet* files as
 * `wallet_sync`/high, and the old `msg.includes('function')` matched the word
 * ANYWHERE, which is most stack traces. The category said which component, and
 * the severity was an accident of naming.
 *
 * This takes the body, never the label, and returns null for anything it does
 * not recognise (unchanged: an unrecognised error is logged, not filed).
 */
export function categoriseConsoleError(
  body: string
): { category: BugCategory; severity: BugSeverity } | null {
  // A malformed literal reaching a typed column is a client boundary defect,
  // never the fault of the subsystem whose name happens to be in the label.
  if (/"code"\s*:\s*"22P0\d"|invalid input syntax for type/i.test(body)) {
    return { category: 'runtime_error', severity: 'high' };
  }
  if (
    /is not a function|is not a constructor|cannot read propert|undefined is not an object/i.test(
      body
    )
  ) {
    return { category: 'runtime_error', severity: 'high' };
  }
  if (
    /\bRPC\b|PGRST\d{3}|function [\w.]+\([^)]*\) does not exist|could not find the function/i.test(
      body
    )
  ) {
    return { category: 'rpc_error', severity: 'high' };
  }
  if (/\bwallets?\b|\bbalance\b/i.test(body)) {
    return { category: 'wallet_sync', severity: 'high' };
  }
  if (/HandController|performAction/.test(body)) {
    return { category: 'action_failure', severity: 'medium' };
  }
  if (/table_seats|buy-?in/i.test(body)) {
    return { category: 'gameplay_anomaly', severity: 'medium' };
  }
  if (/tournament/i.test(body)) {
    return { category: 'tournament_bug', severity: 'medium' };
  }
  return null;
}

/**
 * Is this browser being driven by a test runner?
 *
 * THIS IS NOT AN `is_horse` GATE, AND IT MUST NEVER BECOME ONE (CLAUDE.md
 * 10.5). A horse is a PLAYER: it pays the same buy-in from the same club
 * wallet, sits in the same seat, and every bug it meets is a real bug that
 * belongs in this table exactly like a human's. Nothing here looks at
 * `is_horse` and nothing here may.
 *
 * What this excludes is a ROBOT: `navigator.webdriver` is set only by an
 * automation driver (Playwright, Selenium, Puppeteer), never by a person's
 * browser and never by the engine that runs the horses - horses have no
 * browser at all, so they cannot reach this code path in the first place.
 * The 243 rows this file was audited for were filed by a Playwright process
 * whose reporter identity reads `horse_id: 'console'`, `horse_name: 'Console'`.
 * That is not a horse. It is the post-deploy route suite, writing its own
 * test fixtures into the production bug table on every deploy.
 *
 * Capture is unchanged under automation - the reports still exist in memory
 * and still go out on MasterBus, so a spec can assert on them. Only the
 * production WRITE is withheld.
 */
export function isAutomatedSession(): boolean {
  try {
    return typeof navigator !== 'undefined' && navigator.webdriver === true;
  } catch {
    return false;
  }
}

/**
 * One write per open fingerprint per five minutes. The first occurrence writes
 * immediately; repeats update `last_seen_at` on a throttle rather than on every
 * poll, so a 30-second refresh loop costs 12 writes an hour at worst instead of
 * 120 rows.
 */
const PERSIST_REFRESH_MS = 5 * 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// BUG REPORTER SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class HorseBugReporterService {
  private reports: BugReport[] = [];
  private maxReports = 500;
  private isCapturing = false;
  private originalConsoleError: typeof console.error;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private rejectionListener: ((event: PromiseRejectionEvent) => void) | null = null;
  /** Open fingerprints this session, and when each last reached the database. */
  private openFingerprints = new Map<
    string,
    { id: string; occurrences: number; firstSeen: string; lastReportedAt: number }
  >();

  constructor() {
    this.originalConsoleError = console.error.bind(console);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // START / STOP
  // ─────────────────────────────────────────────────────────────────────────

  /** Start capturing bugs globally */
  startCapturing(): void {
    if (this.isCapturing) return;
    this.isCapturing = true;

    // Intercept console.error
    console.error = (...args: any[]) => {
      this.originalConsoleError(...args);
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');

      // Route on WHAT WENT WRONG, never on the component that raised it.
      // See categoriseConsoleError for the bug this replaces.
      const routed = categoriseConsoleError(splitContextLabel(msg).body);
      if (routed) this.reportFromConsole(msg, routed.category, routed.severity);
    };

    // Global error handler
    this.errorListener = (event: ErrorEvent) => {
      // A capture path may not raise inside the handler that captures. If
      // filing the bug fails, that failure goes to the ORIGINAL console.error
      // and stops there; re-raising here would re-enter window.onerror.
      try {
        this.report({
          horseName: 'GLOBAL',
          horseId: 'system',
          tableId: 'global',
          tableName: 'Global',
          handNumber: 0,
          category: 'runtime_error',
          severity: 'critical',
          title: uncaughtTitle(event.message),
          description: `${event.filename}:${event.lineno}:${event.colno}`,
          context: { filename: event.filename, lineno: event.lineno },
          stackTrace: safeReason(event.error, 'stack'),
        });
      } catch (err) {
        this.originalConsoleError('[HorseBugReporter] error listener failed:', err);
      }
    };
    window.addEventListener('error', this.errorListener);

    // Unhandled promise rejection handler
    this.rejectionListener = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      // A rejection reason is whatever was thrown: a DOMException, a Proxy, a
      // Symbol, an object with a throwing getter. `reason.message` and
      // `String(reason)` are both guarded because both have thrown here.
      try {
        this.report({
          horseName: 'GLOBAL',
          horseId: 'system',
          tableId: 'global',
          tableName: 'Global',
          handNumber: 0,
          category: 'runtime_error',
          severity: 'high',
          title: `Unhandled Promise Rejection`,
          description:
            typeof reason === 'string'
              ? reason
              : safeReason(reason, 'message') || 'Unknown Rejection',
          context: { reason: safeReasonString(reason) },
          stackTrace: safeReason(reason, 'stack'),
        });
      } catch (err) {
        this.originalConsoleError('[HorseBugReporter] rejection listener failed:', err);
      }
    };
    window.addEventListener('unhandledrejection', this.rejectionListener);

    console.debug('[HorseBugReporter] Mini-agent QA system ACTIVE - capturing bugs');
  }

  /** Stop capturing */
  stopCapturing(): void {
    if (!this.isCapturing) return;
    this.isCapturing = false;
    console.error = this.originalConsoleError;
    if (this.errorListener) window.removeEventListener('error', this.errorListener);
    if (this.rejectionListener)
      window.removeEventListener('unhandledrejection', this.rejectionListener);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // REPORT METHODS — Called by horses during gameplay
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Main report method.
   *
   * `dedupe` makes a report an UPDATE of the open row with the same
   * fingerprint instead of a new one, in memory and in the database alike.
   * Callers that report a distinct event (a specific hand, a specific pot)
   * omit it and keep the original one-row-per-call behaviour.
   */
  report(
    data: Omit<BugReport, 'id' | 'timestamp' | 'resolved'>,
    dedupe?: { fingerprint: string }
  ): void {
    const timestamp = new Date().toISOString();

    /* THE ID IS THE DEDUPE. horse_bug_reports.id is a text PRIMARY KEY, so a
       deterministic id derived from the fingerprint makes "one open row per
       bug" a database guarantee rather than a hope held in one tab's memory:
       the second occurrence conflicts with the first and updates it. */
    let entry = dedupe ? this.openFingerprints.get(dedupe.fingerprint) : undefined;
    const id = dedupe
      ? (entry?.id ?? `cbug:${stableHash(dedupe.fingerprint)}`)
      : `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    if (dedupe) {
      if (entry) {
        entry.occurrences += 1;
      } else {
        entry = { id, occurrences: 1, firstSeen: timestamp, lastReportedAt: 0 };
        this.openFingerprints.set(dedupe.fingerprint, entry);
      }
    }

    const report: BugReport = {
      ...data,
      id,
      timestamp,
      resolved: false,
      context:
        dedupe && entry
          ? {
              ...data.context,
              fingerprint: dedupe.fingerprint,
              /* Counted in THIS browser session only. A count across every
                 session needs a server-side increment, which needs a column
                 this change does not add; first_seen_at and last_seen_at are
                 what answer "is it still happening", and they survive. */
              occurrences_this_session: entry.occurrences,
              first_seen_at: entry.firstSeen,
              last_seen_at: timestamp,
            }
          : data.context,
    };

    // One entry per open fingerprint in memory too, updated in place, so the
    // operator dashboard shows the same shape the table does.
    const openIndex = dedupe ? this.reports.findIndex((r) => r.id === id) : -1;
    if (openIndex >= 0) this.reports[openIndex] = report;
    else this.reports.push(report);

    // Trim old reports
    if (this.reports.length > this.maxReports) {
      this.reports = this.reports.slice(-this.maxReports);
    }

    // Broadcast via MasterBus so dashboard can update
    masterBus.emit('HORSE_BUG_REPORT', { ...report } as Record<string, unknown>);

    const worthPersisting =
      report.severity === 'critical' || report.severity === 'high' || report.severity === 'medium';
    /* ONE CLOCK FOR THE WRITE AND THE LOG. The first sighting is reported at
       once; a repeat is reported again only after the throttle. Stamping this
       INSIDE the persist branch instead would have left it unstamped whenever
       the write was withheld - under navigator.webdriver, most of all - so an
       automated session would have printed every repeat to the console while
       writing none of them, which is half the flood in the one place a spec
       asserting a quiet console has to look. */
    const due =
      !entry ||
      entry.lastReportedAt === 0 ||
      Date.now() - entry.lastReportedAt >= PERSIST_REFRESH_MS;
    if (entry && due) entry.lastReportedAt = Date.now();
    const isRepeat = Boolean(entry && entry.occurrences > 1);

    // Persist critical/high/medium to Supabase (fire and forget)
    if (worthPersisting && due && !isAutomatedSession()) {
      this.persistToSupabase(report, Boolean(dedupe)).catch((e) =>
        reportError(e, 'HorseBugReporter.Failed_to_persist')
      );
    }

    // A folded repeat has already been printed once. Printing it again is the
    // console half of the same flood this fold exists to stop.
    if (isRepeat && !due) return;

    // Log with severity color
    const colors: Record<BugSeverity, string> = {
      critical: '\x1b[31m', // red
      high: '\x1b[33m', // yellow
      medium: '\x1b[36m', // cyan
      low: '\x1b[37m', // white
      info: '\x1b[90m', // gray
    };
    // Use console.warn for info/low severity to avoid polluting error console
    const logFn =
      report.severity === 'info' || report.severity === 'low'
        ? console.warn.bind(console)
        : this.originalConsoleError;
    logFn(
      `${colors[report.severity]}[BUG:${report.severity.toUpperCase()}] [${report.horseName}@${report.tableName}] ${report.title}\x1b[0m`
    );
  }

  /**
   * Quick report from the console.error intercept.
   *
   * The 5-second in-memory window that used to live here is gone: it could
   * only ever see the tab it was running in, so a defect re-met every 30
   * seconds, or by a fresh browser context on every deploy, wrote a new row
   * every time. Identity is now a fingerprint and the fold happens against
   * the database. See bugFingerprint.
   */
  private reportFromConsole(msg: string, category: BugCategory, severity: BugSeverity): void {
    this.report(
      {
        horseName: 'Console',
        horseId: 'console',
        tableId: 'unknown',
        tableName: 'Unknown',
        handNumber: 0,
        category,
        severity,
        title: msg.slice(0, 120),
        description: msg,
        context: { source: 'console.error' },
      },
      { fingerprint: bugFingerprint(msg) }
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GAMEPLAY VALIDATORS — Called during horse play
  // ─────────────────────────────────────────────────────────────────────────

  /** Validate chip integrity after an action */
  validateChips(
    horseName: string,
    horseId: string,
    tableId: string,
    tableName: string,
    handNumber: number,
    stackBefore: number,
    stackAfter: number,
    action: string,
    amount: number
  ): void {
    // Check for NaN
    if (isNaN(stackAfter) || isNaN(stackBefore)) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'critical',
        title: `NaN Stack Detected After ${action}`,
        description: `Stack Went From ${stackBefore} To ${stackAfter} After ${action} Of ${amount}`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }

    // Check for negative stack
    if (stackAfter < 0) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'critical',
        title: `Negative Stack: ${stackAfter} After ${action}`,
        description: `Stack Went From ${stackBefore} To ${stackAfter}. Player Should Never Have Negative Chips.`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }

    // Check for impossible chip gain (more than pot)
    if (action === 'win' && amount > stackBefore * 100) {
      this.report({
        horseName,
        horseId,
        tableId,
        tableName,
        handNumber,
        category: 'chip_integrity',
        severity: 'high',
        title: `Suspicious Win Amount: ${amount} (Stack Was ${stackBefore})`,
        description: `Won More Than 100x Stack. Possible Pot Calculation Error.`,
        context: { stackBefore, stackAfter, action, amount },
      });
    }
  }

  /** Validate pot calculation */
  validatePot(
    tableId: string,
    tableName: string,
    handNumber: number,
    potAmount: number,
    playerBets: { name: string; bet: number }[]
  ): void {
    const totalBets = playerBets.reduce((sum, p) => sum + p.bet, 0);

    if (isNaN(potAmount)) {
      this.report({
        horseName: 'PotValidator',
        horseId: 'system',
        tableId,
        tableName,
        handNumber,
        category: 'pot_mismatch',
        severity: 'critical',
        title: 'NaN Pot Detected',
        description: `Pot Is NaN. Player Bets Total: ${totalBets}`,
        context: { potAmount, playerBets },
      });
    }

    if (Math.abs(potAmount - totalBets) > 0.01 && totalBets > 0) {
      this.report({
        horseName: 'PotValidator',
        horseId: 'system',
        tableId,
        tableName,
        handNumber,
        category: 'pot_mismatch',
        severity: 'medium',
        title: `Pot Mismatch: Pot=${potAmount} Vs Bets=${totalBets}`,
        description: `Pot Amount Doesn't Match Sum Of Player Bets. Difference: ${(potAmount - totalBets).toFixed(2)}`,
        context: { potAmount, totalBets, playerBets },
      });
    }
  }

  /** Report an action that was rejected */
  reportActionRejected(
    horseName: string,
    horseId: string,
    tableId: string,
    tableName: string,
    handNumber: number,
    action: string,
    amount: number | undefined,
    reason: string
  ): void {
    this.report({
      horseName,
      horseId,
      tableId,
      tableName,
      handNumber,
      category: 'action_failure',
      severity: 'medium',
      title: `Action Rejected: ${action}${amount ? ` (${amount})` : ''}`,
      description: reason,
      context: { action, amount, reason },
    });
  }

  /** Report a Supabase RPC failure */
  reportRPCError(functionName: string, error: any, context: Record<string, any> = {}): void {
    this.report({
      horseName: 'RPC',
      horseId: 'system',
      tableId: context.tableId || 'unknown',
      tableName: context.tableName || 'Unknown',
      handNumber: context.handNumber || 0,
      category: 'rpc_error',
      severity: 'high',
      title: `RPC Failed: ${functionName}`,
      description: error?.message || String(error),
      context: { functionName, ...context },
      stackTrace: error?.stack,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PERSISTENCE
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist a bug report to Supabase.
   *
   * A fingerprinted report UPSERTS on its deterministic primary key, so the
   * second occurrence refreshes the open row instead of adding one. It also
   * REOPENS a row an operator had resolved, deliberately: a bug that is
   * happening again is not resolved, and last_seen_at says when it came back.
   *
   * `created_at` is deliberately absent from the upserted row. PostgREST
   * builds DO UPDATE from the columns in the payload, so leaving it out keeps
   * the column's own default for the first sighting and leaves it untouched
   * on every refresh: created_at means "first seen", which is what an operator
   * reading this table needs it to mean.
   */
  private async persistToSupabase(report: BugReport, deduped = false): Promise<void> {
    try {
      const row = {
        id: report.id,
        horse_name: report.horseName,
        horse_id: report.horseId,
        table_id: report.tableId,
        table_name: report.tableName,
        hand_number: report.handNumber,
        category: report.category,
        severity: report.severity,
        title: report.title,
        description: report.description,
        context: report.context,
        stack_trace: report.stackTrace || null,
        resolved: false,
      };
      if (deduped) {
        await supabase.from('horse_bug_reports').upsert(row, { onConflict: 'id' });
      } else {
        await supabase.from('horse_bug_reports').insert({ ...row, created_at: report.timestamp });
      }
    } catch (err) {
      /* THE ORIGINAL console.error, NOT THE PATCHED ONE. startCapturing
         replaces console.error with the hook that calls this method; a plain
         console.error here re-entered that hook, so a persistence failure
         could file a report about failing to file a report. */
      this.originalConsoleError('[HorseBugReporter] Error:', err);
      // Silently fail — table might not exist yet
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // QUERY
  // ─────────────────────────────────────────────────────────────────────────

  /** Get all in-memory reports */
  getReports(filter?: {
    severity?: BugSeverity;
    category?: BugCategory;
    resolved?: boolean;
  }): BugReport[] {
    let results = [...this.reports];
    if (filter?.severity) results = results.filter((r) => r.severity === filter.severity);
    if (filter?.category) results = results.filter((r) => r.category === filter.category);
    if (filter?.resolved !== undefined)
      results = results.filter((r) => r.resolved === filter.resolved);
    return results.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
  }

  /** Get summary stats */
  getStats(): {
    total: number;
    bySeverity: Record<BugSeverity, number>;
    byCategory: Record<string, number>;
    unresolvedCount: number;
    lastReportTime: string | null;
  } {
    const bySeverity: Record<BugSeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };
    const byCategory: Record<string, number> = {};
    let unresolvedCount = 0;

    for (const r of this.reports) {
      bySeverity[r.severity]++;
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      if (!r.resolved) unresolvedCount++;
    }

    return {
      total: this.reports.length,
      bySeverity,
      byCategory,
      unresolvedCount,
      lastReportTime:
        this.reports.length > 0 ? this.reports[this.reports.length - 1].timestamp : null,
    };
  }

  /** Mark a report as resolved */
  resolve(reportId: string): void {
    const report = this.reports.find((r) => r.id === reportId);
    if (report) report.resolved = true;
  }

  /** Clear all reports */
  clear(): void {
    this.reports = [];
    this.openFingerprints.clear();
  }
}

// Singleton
export const horseBugReporter = new HorseBugReporterService();
