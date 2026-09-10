/** Existing shared request budget, originally used by roster reads. */
export const DEFAULT_REQUEST_DEADLINE_MS = 12_000;

export class RequestDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super('The Request Timed Out. Check The Current State Before Trying Again.');
    this.name = 'RequestDeadlineError';
  }
}
export interface RequestDeadlineOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  timeoutError?: (timeoutMs: number) => Error;
  abortError?: () => Error;
}

/** One bounded attempt. This helper never retries an operation. */
export function runWithRequestDeadline<T>(
  operation: (signal: AbortSignal) => PromiseLike<T> | T,
  options: RequestDeadlineOptions = {}
): Promise<T> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_REQUEST_DEADLINE_MS);
  const abortError =
    options.abortError ?? (() => new DOMException('The Request Was Cancelled.', 'AbortError'));
  const timeoutError = options.timeoutError ?? ((ms: number) => new RequestDeadlineError(ms));
  if (options.signal?.aborted) return Promise.reject(abortError());
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      controller.abort();
      finish(() => reject(abortError()));
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish(() => reject(timeoutError(timeoutMs)));
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw abortError();
        return operation(controller.signal);
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error))
      );
  });
}
