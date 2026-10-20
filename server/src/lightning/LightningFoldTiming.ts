/** Bounded diagnostics on the original fold request. Never retries or changes its outcome. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MS = 900_000;
const MAX_ATTEMPTS = 6;
const SLOW_MS = 350;
const MAX_LINES = 20;
const INTERVAL_MS = 50;
const boundedMs = (n: number): number =>
  Number.isFinite(n) ? Math.round(Math.max(0, Math.min(MAX_MS, n)) * 1000) / 1000 : 0;
const increment = (n: number): number => Math.min(Number.MAX_SAFE_INTEGER, n + 1);

export interface LightningFoldFetchTrace {
  headers(response: Response): void;
  bodyComplete(): void;
}

interface Attempt {
  startMs: number;
  headersMs: number | null;
  bodyMs: number | null;
  status: number | null;
  providerRequestId: string | null;
  upstreamMs: number | null;
  outcome: 'pending' | 'fulfilled' | 'rejected';
}

interface Span {
  requestId: string;
  startedAt: number;
  timerLateMs: number;
  attempts: Attempt[];
  attemptsOmitted: number;
  closed: boolean;
}

const NO_TRACE: LightningFoldFetchTrace = Object.freeze({ headers() {}, bodyComplete() {} });

/** Injectable monotonic clock/log only; production uses the native interval, always unreferenced. */
export function createLightningFoldTiming(
  deps: {
    now?: () => number;
    log?: (line: string) => void;
  } = {}
) {
  const context = new AsyncLocalStorage<Span>();
  const now = deps.now ?? (() => performance.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  let windowStart = now();
  let emitted = 0;
  let omitted = 0;

  async function traceLightningFold<T>(requestId: string, work: () => Promise<T>): Promise<T> {
    // Invalid IDs disable diagnostics rather than rejecting a legitimate action.
    if (!UUID.test(requestId)) return context.exit(work);
    const span: Span = {
      requestId: requestId.toLowerCase(),
      startedAt: now(),
      timerLateMs: 0,
      attempts: [],
      attemptsOmitted: 0,
      closed: false,
    };
    return context.run(span, async () => {
      let expected = span.startedAt + INTERVAL_MS;
      const timer = setInterval(() => {
        const sampledAt = now();
        span.timerLateMs = Math.max(span.timerLateMs, boundedMs(sampledAt - expected));
        expected = sampledAt + INTERVAL_MS;
      }, INTERVAL_MS);
      timer.unref();
      let outcome: 'fulfilled' | 'rejected' = 'fulfilled';
      try {
        return await work();
      } catch (error) {
        outcome = 'rejected';
        throw error;
      } finally {
        clearInterval(timer);
        span.closed = true;
        const finishedAt = now();
        // A blocked loop may finish the request before its overdue interval can run.
        span.timerLateMs = Math.max(span.timerLateMs, boundedMs(finishedAt - expected));
        const totalMs = boundedMs(finishedAt - span.startedAt);
        if (totalMs >= SLOW_MS) {
          if (finishedAt - windowStart >= 60_000) {
            windowStart = finishedAt;
            emitted = 0;
          }
          if (emitted >= MAX_LINES) omitted = increment(omitted);
          else {
            emitted++;
            const report = {
              version: 1,
              requestId: span.requestId,
              totalMs,
              timerLateMs: boundedMs(span.timerLateMs),
              outcome,
              attempts: span.attempts,
              attemptsOmitted: span.attemptsOmitted,
              omitted,
            };
            omitted = 0;
            // Diagnostics cannot replace the original fulfillment or rejection.
            try {
              log('[LightningFoldTiming] ' + JSON.stringify(report));
            } catch {
              /* observer only */
            }
          }
        }
      }
    });
  }

  function measureLightningFoldFetch(
    work: (trace: LightningFoldFetchTrace) => Promise<Response>
  ): Promise<Response> {
    const span = context.getStore();
    if (!span || span.closed) return work(NO_TRACE);
    if (span.attempts.length >= MAX_ATTEMPTS) {
      span.attemptsOmitted = increment(span.attemptsOmitted);
      return work(NO_TRACE);
    }
    const attempt: Attempt = {
      startMs: boundedMs(now() - span.startedAt),
      headersMs: null,
      bodyMs: null,
      status: null,
      providerRequestId: null,
      upstreamMs: null,
      outcome: 'pending',
    };
    span.attempts.push(attempt);
    const trace: LightningFoldFetchTrace = {
      headers(response) {
        if (span.closed || attempt.headersMs !== null) return;
        attempt.headersMs = boundedMs(now() - span.startedAt);
        // Only these two explicitly sanitized metadata values cross the boundary.
        try {
          const id = response.headers.get('sb-request-id');
          const upstream = response.headers.get('x-envoy-upstream-service-time');
          attempt.providerRequestId = id && UUID.test(id) ? id.toLowerCase() : null;
          if (upstream && /^\d+(?:\.\d+)?$/.test(upstream)) {
            const numeric = Number(upstream);
            if (Number.isFinite(numeric) && numeric <= MAX_MS) attempt.upstreamMs = numeric;
          }
          const status = response.status;
          attempt.status =
            Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
        } catch {
          /* missing or unreadable diagnostic metadata never changes the fetch */
        }
      },
      bodyComplete() {
        if (!span.closed && attempt.bodyMs === null)
          attempt.bodyMs = boundedMs(now() - span.startedAt);
      },
    };
    return (async () => {
      try {
        const response = await work(trace);
        if (!span.closed) attempt.outcome = 'fulfilled';
        return response;
      } catch (error) {
        if (!span.closed) attempt.outcome = 'rejected';
        throw error;
      }
    })();
  }

  return { traceLightningFold, measureLightningFoldFetch };
}

const timing = createLightningFoldTiming();
export const traceLightningFold = timing.traceLightningFold;
export const measureLightningFoldFetch = timing.measureLightningFoldFetch;
