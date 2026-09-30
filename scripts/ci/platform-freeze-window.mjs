#!/usr/bin/env node
/**
 * platform-freeze-window.mjs - wait for the freeze to END, not for a tick count.
 *
 * WHY THIS EXISTS (2026-09-30)
 *
 * Two production fixture cleanups - `scripts/ci/production-e2e-account.mjs` and
 * `tests/e2e/support/temporaryCustomizationAccount.ts` - handled the hourly
 * platform freeze (CLAUDE.md section 13) with the same blind loop:
 *
 *     for (attempt = 0; attempt < 37; attempt++) { rpc(); sleep(10_000); }
 *
 * 37 x 10s = 370s. Measured against `public.engine_maintenance_break_log`, all
 * 435 breaks between 2026-09-16 18:55Z and 2026-09-30 17:55Z:
 *
 *     min 395s | median 417s | mean 448s | p95 532s | p99 550s
 *     longest ordinary 578s (2026-09-28 15:55Z)
 *     longest observed  4222s (2026-09-18 17:55Z - an incident, not a break)
 *     breaks that finished inside 370s: 0 of 435
 *     breaks that finished inside the documented 5 minutes: 0 of 435
 *
 * So a cleanup that opened inside a freeze ALWAYS ran out of budget. Not
 * sometimes. Every time.
 *
 * RAISING THE COUNT IS NOT THE FIX (CLAUDE.md 10.86 rule 4). The Playwright
 * callers sit inside a 600s/720s test timeout inside a 50-minute job, so a
 * bigger blind budget only fails one level up, where the cause is harder to
 * read. The freeze is not a duration to guess at - it is a single row in
 * `public.engine_maintenance_break`, and `public.fn_platform_frozen()` answers
 * it authoritatively. Wait on THAT, and size the wait from what the row says.
 *
 * THE BUDGET IS READ, NOT ASSUMED
 *
 * `freezeBudgetMs()` asks the row when the break is scheduled to end and adds
 * the measured tail the engine actually takes past that instant to finish
 * thawing: 95s minimum, 139s mean, 231s p95, 278s longest ordinary. The tail
 * constant is 300s, the longest ordinary tail rounded up. A cleanup that opens
 * at the very top of a freeze therefore waits at most 300s + 300s = 600s, which
 * covers the longest ordinary freeze ever recorded (578s) with room; a cleanup
 * that opens near the end waits only what is left.
 *
 * THE CEILING IS THE DATABASE'S OWN, NOT A NUMBER SOMEBODY LIKED
 *
 * When the row cannot be read the budget falls back to PLATFORM_FREEZE_CEILING_MS,
 * 900s. That is not a guess either: `fn_platform_frozen()` only honours a
 * counting-down row whose `break_ends_at < announced_at + INTERVAL '15 minutes'`,
 * so 15 minutes is the longest freeze the database will enforce at all. Waiting
 * past it would be waiting for something that is no longer a freeze.
 *
 * "I COULD NOT TELL" IS NOT "NOT FROZEN" (CLAUDE.md 10.86 rules 1 and 2)
 *
 * A failed read of the freeze state is never treated as a thaw. It keeps the
 * wait running and is counted, and a wait whose every read failed returns
 * `unreadable` so the caller can say so instead of claiming a freeze refused it.
 */

/** Measured from `public.engine_maintenance_break_log`; see the header. Milliseconds. */
export const PLATFORM_FREEZE_MEASUREMENT = Object.freeze({
  source: 'public.engine_maintenance_break_log',
  sampledFrom: '2026-09-16T18:55Z',
  sampledTo: '2026-09-30T17:55Z',
  breaks: 435,
  minMs: 395_000,
  medianMs: 417_000,
  meanMs: 448_000,
  p95Ms: 532_000,
  p99Ms: 550_000,
  longestOrdinaryMs: 578_000,
  /** 2026-09-18 17:55Z. An incident, deliberately excluded from every budget. */
  longestObservedMs: 4_222_000,
  breaksThatFinishedInsideTheOldBudget: 0,
  breaksThatFinishedInsideTheDocumentedWindow: 0,
  tailPastBreakEndsAt: Object.freeze({
    minMs: 95_000,
    meanMs: 139_000,
    p95Ms: 231_000,
    longestOrdinaryMs: 278_000,
  }),
});

/**
 * How long the engine actually takes to finish thawing after `break_ends_at`.
 * 300s = the longest ordinary tail measured (278s) rounded up. Never the
 * documented zero: 0 of 435 breaks ended at `break_ends_at`.
 */
export const PLATFORM_FREEZE_THAW_TAIL_MS = 300_000;

/**
 * The longest freeze the database itself will enforce: `fn_platform_frozen()`
 * ignores a counting-down row whose window exceeds announced_at + 15 minutes.
 * Used only when the break row cannot be read.
 */
export const PLATFORM_FREEZE_CEILING_MS = 900_000;

/** The thaw is one row flipping phase; ask often enough not to waste it. */
export const PLATFORM_FREEZE_POLL_MS = 5_000;

/**
 * The longest a freeze can still have left to run when a caller first meets it:
 * the whole 300s window the row schedules, plus the 300s measured tail. Used
 * where the enclosing budget must be sized in advance - a Playwright test
 * cannot discover halfway through that it needs another ten minutes - so the
 * three specs that own production fixtures add exactly this to their own
 * timeout and nothing more (CLAUDE.md 10.86 rule 4: the level up was checked,
 * the job allows 50 minutes and normally spends 20-24).
 */
export const PLATFORM_FREEZE_WORST_CASE_MS = 300_000 + PLATFORM_FREEZE_THAW_TAIL_MS;

/**
 * What remains of THIS freeze, from the row, not from a tick count.
 *
 * @param {{ break_ends_at?: string|null, breakEndsAt?: string|null }|null|undefined} breakRow
 * @param {number} nowMs
 * @returns {number} milliseconds, between one poll and PLATFORM_FREEZE_CEILING_MS
 */
export function freezeBudgetMs(breakRow, nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error('freezeBudgetMs needs the current time.');
  const raw = breakRow?.break_ends_at ?? breakRow?.breakEndsAt ?? null;
  const endsAt = raw ? Date.parse(String(raw)) : Number.NaN;
  if (!Number.isFinite(endsAt)) return PLATFORM_FREEZE_CEILING_MS;
  const remaining = Math.max(0, endsAt - nowMs) + PLATFORM_FREEZE_THAW_TAIL_MS;
  return Math.min(PLATFORM_FREEZE_CEILING_MS, Math.max(PLATFORM_FREEZE_POLL_MS, remaining));
}

/**
 * Poll the freeze's own end condition until it lifts, the budget is spent, or
 * every read failed.
 *
 * @param {{
 *   isFrozen: () => Promise<boolean>,
 *   budgetMs: number,
 *   sleep?: (ms: number) => Promise<unknown>,
 *   now?: () => number,
 *   pollMs?: number,
 *   onPoll?: (state: { waitedMs: number, budgetMs: number, frozen: boolean|null }) => void,
 * }} options
 * @returns {Promise<{ outcome: 'thawed'|'exhausted'|'unreadable', waitedMs: number,
 *   budgetMs: number, polls: number, failedReads: number, lastError: string|null }>}
 */
export async function awaitPlatformThaw({
  isFrozen,
  budgetMs,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  pollMs = PLATFORM_FREEZE_POLL_MS,
  onPoll,
}) {
  if (typeof isFrozen !== 'function') throw new Error('awaitPlatformThaw needs an isFrozen read.');
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('awaitPlatformThaw needs a positive budget.');
  }
  const startedAt = now();
  /**
   * Bound the wait by the polls it intends as well as by the clock. A caller
   * that injects an instant sleep (every unit test does) would otherwise spin
   * the budget out one microsecond at a time, and a wait that cannot terminate
   * on its own terms is not a budget.
   */
  const maxPolls = Math.ceil(budgetMs / pollMs) + 1;
  let polls = 0;
  let failedReads = 0;
  let lastError = null;

  for (;;) {
    let frozen = null;
    try {
      frozen = (await isFrozen()) === true;
    } catch (error) {
      // 10.86 rule 2: an unreadable answer is never coerced into a good one.
      failedReads += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }
    polls += 1;
    const waitedMs = now() - startedAt;
    onPoll?.({ waitedMs, budgetMs, frozen });
    if (frozen === false) {
      return { outcome: 'thawed', waitedMs, budgetMs, polls, failedReads, lastError };
    }
    if (waitedMs + pollMs > budgetMs || polls >= maxPolls) {
      return {
        outcome: failedReads === polls ? 'unreadable' : 'exhausted',
        waitedMs,
        budgetMs,
        polls,
        failedReads,
        lastError,
      };
    }
    await sleep(pollMs);
  }
}

/**
 * The one sentence a caller prints or throws. It names the measurement so the
 * next reader does not have to go and find it again.
 *
 * @param {{ outcome: string, waitedMs: number, budgetMs: number, failedReads: number,
 *   lastError: string|null }} result
 * @returns {string}
 */
export function describeThaw(result) {
  const seconds = (ms) => `${Math.round(ms / 1000)}s`;
  const measured =
    `measured ${PLATFORM_FREEZE_MEASUREMENT.breaks} breaks: ` +
    `min ${seconds(PLATFORM_FREEZE_MEASUREMENT.minMs)}, ` +
    `mean ${seconds(PLATFORM_FREEZE_MEASUREMENT.meanMs)}, ` +
    `p95 ${seconds(PLATFORM_FREEZE_MEASUREMENT.p95Ms)}, ` +
    `longest ordinary ${seconds(PLATFORM_FREEZE_MEASUREMENT.longestOrdinaryMs)}`;
  if (result.outcome === 'thawed') {
    return `the platform freeze lifted after ${seconds(result.waitedMs)} (${measured})`;
  }
  if (result.outcome === 'unreadable') {
    return (
      `the platform freeze state could not be read at all in ${seconds(result.waitedMs)} ` +
      `(${result.failedReads} failed read(s); last: ${result.lastError || 'unknown'}); ` +
      'this is UNKNOWN, not a thaw'
    );
  }
  return (
    `the platform freeze was still enforced after ${seconds(result.waitedMs)} ` +
    `of a ${seconds(result.budgetMs)} budget read from engine_maintenance_break (${measured})`
  );
}
