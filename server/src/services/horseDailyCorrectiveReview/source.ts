import { DAILY_LIMITS, type DailyRequest, type DailySource } from './contract.js';
import { parseDailyPage, validateRequest } from './validation.js';
type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = typeof fetch;
function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(Error('daily_source_unavailable'));
    };
    if (signal.aborted) {
      reject(Error('daily_source_unavailable'));
      void operation.catch(() => {});
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', abort);
        reject(Error('daily_source_unavailable'));
      }
    );
  });
}
/** Called only by explicit offline execution. No ambient URL, dotenv, client,
 * subscription, retry, configuration read or network operation on import. */
export function createDailyReviewSource(
  environment: Environment,
  fetcher: Fetcher = fetch
): DailySource {
  const origin = environment.SUPABASE_URL,
    key = environment.SUPABASE_SERVICE_ROLE_KEY;
  let url: URL;
  try {
    if (
      !origin ||
      origin.length > 2048 ||
      origin !== origin.trim() ||
      !key ||
      key !== key.trim() ||
      key.length > 8192 ||
      /[\r\n\0]/.test(key)
    )
      throw Error();
    url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (origin !== url.origin && origin !== url.origin + '/')
    )
      throw Error();
  } catch {
    throw Error('daily_source_configuration_unavailable');
  }
  const endpoint = new URL('/rest/v1/rpc/fn_horse_commitment_review_page', url.origin).href;
  return async (request: DailyRequest) => {
    validateRequest(request);
    const captured = { day: request.day, after: request.after ? { ...request.after } : null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DAILY_LIMITS.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      // The installed Node declarations expose Request.cache but omit it from
      // RequestInit. Keep the no-store option explicitly typed at this boundary.
      const init: RequestInit & Pick<Request, 'cache'> = {
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-smarter-data-actor': 'service',
          'x-smarter-data-protocol': '1',
        },
        body: JSON.stringify({
          p_day: captured.day,
          p_after_played_at: captured.after?.playedAt ?? null,
          p_after_hand_id: captured.after?.handId ?? null,
          p_after_horse_user_id: captured.after?.horseId ?? null,
          p_limit: DAILY_LIMITS.pageRows,
        }),
        signal: controller.signal,
      };
      const response = await untilAbort(fetcher(endpoint, init), controller.signal);
      if (!response.ok || !response.body) throw Error();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > DAILY_LIMITS.wireBytes))
        throw Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await untilAbort(reader.read(), controller.signal);
        if (part.done) break;
        if (part.value.byteLength === 0) throw Error();
        bytes += part.value.byteLength;
        if (bytes > DAILY_LIMITS.wireBytes) throw Error();
        chunks.push(new Uint8Array(part.value));
      }
      const encoding = response.headers.get('content-encoding');
      if (length !== null && (!encoding || encoding === 'identity') && Number(length) !== bytes)
        throw Error();
      const raw = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        raw.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      return parseDailyPage(JSON.parse(text), captured);
    } catch {
      throw Error('daily_source_unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (reader) {
        void reader.cancel().catch(() => {});
        try {
          reader.releaseLock();
        } catch {
          /* pending transport read owns no review success */
        }
      }
    }
  };
}
