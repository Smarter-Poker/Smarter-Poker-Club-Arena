/** Bound the network operation that holds auth-js's shared session lock. */
export const AUTH_FETCH_DEADLINE_MS = 10_000;

export async function fetchAuthWithDeadline(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const upstream = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        controller.abort();
        reject(new DOMException('Authentication request aborted', 'AbortError'));
      };
      upstream?.addEventListener('abort', onAbort, { once: true });
      if (upstream?.aborted) {
        onAbort();
        return;
      }
      timer = setTimeout(onAbort, AUTH_FETCH_DEADLINE_MS);
    });
    const operation = (async () => {
      if (controller.signal.aborted)
        throw new DOMException('Authentication request aborted', 'AbortError');
      const response = await fetch(input, { ...init, signal: controller.signal });
      // Headers alone are not completion. A stalled token body otherwise
      // retains the SDK lock after fetch has already resolved.
      const body = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    })();
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort) upstream?.removeEventListener('abort', onAbort);
  }
}
