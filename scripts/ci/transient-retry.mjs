/**
 * Bounded retry for CI calls into the production database whose only failure
 * was that the database was slow.
 *
 * WHY THIS EXISTS (2026-09-28). A Club Create Certification run retired one of
 * its two fixture clubs and lost the other to "canceling statement due to
 * statement timeout" (service_role is capped at 8 s, and the database was under
 * load). The script logged it and moved on, the reserved identity still owned a
 * club, and from then on every Post-Deploy E2E run died at account provisioning
 * for about ten hours. One slow call became a wedged engine certificate.
 *
 * The rule is narrow on purpose:
 *   - A failure that says "the database was busy" (statement/lock timeout,
 *     deadlock, serialization failure, PostgREST schema-cache 503s, a gateway
 *     5xx, a dropped connection) is retried a bounded number of times with
 *     backoff. Only callers whose operation is idempotent may use this.
 *   - Everything else is DEFINITIVE and is never retried: a `success: false`
 *     body, a permission error, a guard refusal (a plain HTTP 500 carrying a
 *     non-transient SQLSTATE such as 55000 is a refusal, not an outage).
 *   - Running out of attempts throws the last transient failure. A retry never
 *     turns a failure into a pass.
 *
 * Do not use this around anything that is not idempotent: replaying an executed
 * write is a money-integrity hazard (CLAUDE.md section 2, DDL policy rule 6).
 */

export const TRANSIENT_RETRY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000, 16_000]);

// query_canceled (statement timeout), lock_not_available, serialization_failure,
// deadlock_detected, too_many_connections, and PostgREST's pre-execution
// schema-cache / connection failures. Every one of these is raised before the
// caller's work can have committed, or is safe to observe again.
const TRANSIENT_SQLSTATES = new Set([
  '57014',
  '55P03',
  '40001',
  '40P01',
  '53300',
  'PGRST000',
  'PGRST001',
  'PGRST002',
  'PGRST003',
]);

// A gateway or platform answering for a database it could not reach. A bare 500
// is deliberately absent: PostgREST returns 500 for a RAISE EXCEPTION with an
// application SQLSTATE, and that is the guard speaking.
const TRANSIENT_HTTP_STATUSES = new Set([408, 429, 502, 503, 504, 520, 521, 522, 523, 524]);

const TRANSIENT_MESSAGE =
  /statement timeout|lock timeout|canceling statement|deadlock detected|could not obtain lock|could not serialize|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|UND_ERR/i;

/**
 * @param {unknown} failure An Error (optionally carrying `status`/`code`/`body`)
 *   or a supabase-js `error` object `{ code, message }`.
 */
export function isTransientFailure(failure) {
  if (!failure || typeof failure !== 'object') return false;
  const candidate = /** @type {Record<string, any>} */ (failure);
  const body = candidate.body && typeof candidate.body === 'object' ? candidate.body : {};
  const code = String(candidate.code ?? body.code ?? '');
  if (code && TRANSIENT_SQLSTATES.has(code)) return true;
  const status = Number(candidate.status);
  if (Number.isFinite(status) && TRANSIENT_HTTP_STATUSES.has(status)) return true;
  // A definitive application SQLSTATE outranks a timeout-shaped word in its text.
  if (code && !TRANSIENT_SQLSTATES.has(code)) return false;
  const message = `${candidate.message ?? ''} ${body.message ?? ''}`;
  return TRANSIENT_MESSAGE.test(message);
}

/**
 * Run `operation`, retrying while it fails transiently.
 *
 * @param {() => Promise<any>} operation Idempotent.
 * @param {object} [options]
 * @param {(value: any) => unknown} [options.failureOf] Maps a RETURNED value to
 *   the failure it carries (supabase-js returns `{ data, error }` rather than
 *   throwing): `(result) => result.error`. Thrown errors are always considered.
 * @param {number[]} [options.delaysMs] Wait before retry n; length + 1 attempts.
 * @param {(ms: number) => Promise<void>} [options.wait]
 * @param {string} [options.label] For the log line only.
 */
export async function retryTransient(
  operation,
  {
    failureOf = () => undefined,
    delaysMs = TRANSIENT_RETRY_DELAYS_MS,
    wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    label = 'database call',
  } = {}
) {
  for (let attempt = 0; ; attempt += 1) {
    let value;
    let thrown;
    let failed = false;
    try {
      value = await operation();
    } catch (error) {
      thrown = error;
      failed = true;
    }
    const failure = failed ? thrown : failureOf(value);
    const retryable = Boolean(failure) && isTransientFailure(failure) && attempt < delaysMs.length;
    if (!retryable) {
      if (failed) throw thrown;
      return value;
    }
    const reason = String(/** @type {any} */ (failure)?.message || failure).slice(0, 200);
    console.warn(
      `[transient-retry] ${label} failed transiently (${reason}); retry ${attempt + 1} of ${delaysMs.length} in ${delaysMs[attempt]} ms.`
    );
    await wait(delaysMs[attempt]);
  }
}
