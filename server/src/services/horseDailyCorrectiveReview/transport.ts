import { DAILY_LIMITS } from './contract.js';
type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = typeof fetch;
/** The only private service RPCs this offline tooling may call. All three are
 * read-only service-role readers; none writes, leases or authorizes anything. */
export const DAILY_PRIVATE_RPCS = Object.freeze([
  'fn_horse_commitment_review_page',
  'fn_horse_commitment_selection_receipt',
  'fn_horse_accepted_source_rows',
] as const);
export type DailyPrivateRpc = (typeof DAILY_PRIVATE_RPCS)[number];
export type DailyRpcCall = (
  name: DailyPrivateRpc,
  body: Readonly<Record<string, unknown>>,
  wireBytes: number
) => Promise<unknown>;
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
/** One bounded POST per call: service key from the captured environment,
 * no-store, no redirect, no credentials, local timeout, exact decoded byte cap
 * and no retry. Called only by explicit offline execution; nothing on import.
 * Every failure is the same fixed error so no private body can leak. */
export function createDailyPrivateRpc(
  environment: Environment,
  fetcher: Fetcher = fetch
): DailyRpcCall {
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
  const base = url.origin;
  return async (name, body, wireBytes) => {
    if (
      !DAILY_PRIVATE_RPCS.includes(name) ||
      !Number.isSafeInteger(wireBytes) ||
      wireBytes < 1 ||
      wireBytes > DAILY_LIMITS.sourceRowWireBytes
    )
      throw Error('daily_source_unavailable');
    const endpoint = new URL(`/rest/v1/rpc/${name}`, base).href;
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
        body: JSON.stringify(body),
        signal: controller.signal,
      };
      const response = await untilAbort(fetcher(endpoint, init), controller.signal);
      if (!response.ok || !response.body) throw Error();
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > wireBytes)) throw Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const part = await untilAbort(reader.read(), controller.signal);
        if (part.done) break;
        if (part.value.byteLength === 0) throw Error();
        bytes += part.value.byteLength;
        if (bytes > wireBytes) throw Error();
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
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) as unknown;
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
