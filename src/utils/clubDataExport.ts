export type ClubDataExportStage = 'preparing' | 'downloading';

export interface ClubDataExportProgress {
  stage: ClubDataExportStage;
  loaded: number;
  total: number | null;
}

type RpcResult<T> = { data: T | null; error: unknown };
type AbortableRpcRequest<T> = PromiseLike<RpcResult<T>> & {
  abortSignal?: (signal: AbortSignal) => AbortableRpcRequest<T>;
};

export type ClubDataExportRpc = (
  name: string,
  args: Record<string, unknown>
) => AbortableRpcRequest<unknown>;

export type ClubDataExportStartRpc =
  | 'ca_club_game_export_start'
  | 'ca_club_player_export_start'
  | 'ca_rake_export_start';

interface StartPayload {
  export_id?: unknown;
  total_rows?: unknown;
  status?: unknown;
}

interface PagePayload {
  rows?: unknown;
  total_rows?: unknown;
  next_offset?: unknown;
  has_more?: unknown;
}

export interface FetchClubDataExportOptions<Row> {
  rpc: ClubDataExportRpc;
  startRpc: ClubDataExportStartRpc;
  startArgs: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  /** Runtime validation for export families with a typed server contract. */
  validateRow?: (row: unknown) => row is Row;
  rowKey: (row: Row) => string;
  /**
   * Optional immutable-receipt checks. Game/player exports predate receipt
   * metadata; Rake exports use both hooks to bind every page to one exact
   * scope, range, search, sort, and entitlement snapshot.
   */
  validateReceipt?: (receipt: Readonly<Record<string, unknown>>) => boolean;
  validatePage?: (
    page: Readonly<Record<string, unknown>>,
    receipt: Readonly<Record<string, unknown>>
  ) => boolean;
  onPrepared?: (receipt: Readonly<Record<string, unknown>>) => void;
  onProgress?: (progress: ClubDataExportProgress) => void;
  pageSize?: number;
  /** Immutable dense-ordinal exports may require every requested page. */
  requireFullPages?: boolean;
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}

function rpcError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object') {
    const source = error as { message?: unknown; code?: unknown };
    const normalized = new Error(String(source.message || fallback)) as Error & {
      code?: string;
    };
    if (typeof source.code === 'string') normalized.code = source.code;
    return normalized;
  }
  return new Error(fallback);
}

async function request<T>(
  rpcRequest: AbortableRpcRequest<unknown>,
  signal: AbortSignal,
  recoverSuccessfulResponseAfterAbort = false
) {
  if (signal.aborted) throw abortError();
  const bound =
    typeof rpcRequest.abortSignal === 'function' ? rpcRequest.abortSignal(signal) : rpcRequest;
  const result = (await Promise.resolve(bound)) as RpcResult<T>;
  if (signal.aborted && (!recoverSuccessfulResponseAfterAbort || result.error)) throw abortError();
  if (result.error) throw rpcError(result.error, 'The export service returned an error.');
  return result.data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Fetch one immutable server-prepared export. A file is only returned when the
 * client received exactly the announced number of unique rows. The short-lived
 * server copy is scheduled for deletion after success, failure, or
 * cancellation. Cleanup is deliberately detached: an unavailable cleanup
 * endpoint cannot hold a completed browser download hostage, and abandoned
 * jobs also expire at the database doors.
 */
export async function fetchClubDataExport<Row>(
  options: FetchClubDataExportOptions<Row>
): Promise<Row[]> {
  if (options.signal.aborted) throw abortError();
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 1000, 2000));
  let exportId: string | null = null;
  options.onProgress?.({ stage: 'preparing', loaded: 0, total: null });

  try {
    const started = await request<StartPayload>(
      options.rpc(options.startRpc, {
        ...options.startArgs,
        p_request_id: options.requestId,
      }),
      options.signal,
      true
    );
    exportId = typeof started?.export_id === 'string' ? started.export_id : null;
    // An adapter can finish after AbortSignal fires. Keep the receipt only
    // long enough for finally to retire its server-side job.
    if (options.signal.aborted) throw abortError();
    const total = started?.total_rows;
    if (
      !isRecord(started) ||
      !exportId ||
      started.status !== 'ready' ||
      typeof total !== 'number' ||
      !Number.isInteger(total) ||
      total < 0 ||
      (options.validateReceipt && !options.validateReceipt(started))
    ) {
      throw new Error('The export service returned an invalid preparation receipt.');
    }
    options.onPrepared?.(started);

    const rows: Row[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let hasMore = total > 0;
    options.onProgress?.({ stage: 'downloading', loaded: 0, total });

    while (hasMore) {
      const page = await request<PagePayload>(
        options.rpc('ca_club_data_export_page', {
          p_export_id: exportId,
          p_offset: offset,
          p_limit: pageSize,
        }),
        options.signal
      );
      if (
        !isRecord(page) ||
        !Array.isArray(page.rows) ||
        page.total_rows !== total ||
        typeof page.has_more !== 'boolean' ||
        (options.validatePage && !options.validatePage(page, started))
      ) {
        throw new Error('The export changed while it was being downloaded.');
      }
      const nextOffset = page.next_offset;
      if (
        typeof nextOffset !== 'number' ||
        !Number.isInteger(nextOffset) ||
        nextOffset !== offset + page.rows.length ||
        (page.has_more && nextOffset <= offset) ||
        nextOffset > total ||
        page.rows.length > pageSize ||
        page.has_more !== nextOffset < total
      ) {
        throw new Error('The export service returned an invalid continuation.');
      }
      const expectedRows = Math.min(pageSize, total - offset);
      if (options.requireFullPages && page.rows.length !== expectedRows) {
        throw new Error('The export stopped before every row was delivered.');
      }

      const validatedRows: Row[] = [];
      for (const candidate of page.rows) {
        if (options.validateRow && !options.validateRow(candidate)) {
          throw new Error('The export contained a malformed row.');
        }
        validatedRows.push(candidate as Row);
      }

      for (const row of validatedRows) {
        const key = options.rowKey(row);
        if (!key || seen.has(key)) {
          throw new Error('The export contained a duplicate or unidentified row.');
        }
        seen.add(key);
        rows.push(row);
      }
      offset = nextOffset;
      hasMore = page.has_more;
      options.onProgress?.({ stage: 'downloading', loaded: rows.length, total });
    }

    if (rows.length !== total || offset !== total) {
      throw new Error(`The export delivered ${rows.length} of ${total} rows.`);
    }
    return rows;
  } finally {
    if (exportId) {
      try {
        void Promise.resolve(
          options.rpc('ca_club_data_export_cancel', { p_export_id: exportId })
        ).catch(() => undefined);
      } catch {
        // Jobs expire after fifteen minutes. Cleanup must never hide the real
        // export outcome from the operator.
      }
    }
  }
}

export function isClubDataExportAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
