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

interface StartPayload {
  export_id?: unknown;
  total_rows?: unknown;
  status?: unknown;
}

interface PagePayload<Row> {
  rows?: Row[];
  total_rows?: unknown;
  next_offset?: unknown;
  has_more?: unknown;
}

export interface FetchClubDataExportOptions<Row> {
  rpc: ClubDataExportRpc;
  startRpc: 'ca_club_game_export_start' | 'ca_club_player_export_start';
  startArgs: Record<string, unknown>;
  requestId: string;
  signal: AbortSignal;
  rowKey: (row: Row) => string;
  onProgress?: (progress: ClubDataExportProgress) => void;
  pageSize?: number;
}

function abortError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}

function rpcError(error: unknown, fallback: string): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error) {
    return new Error(String((error as { message?: unknown }).message || fallback));
  }
  return new Error(fallback);
}

async function request<T>(rpcRequest: AbortableRpcRequest<unknown>, signal: AbortSignal) {
  if (signal.aborted) throw abortError();
  const bound =
    typeof rpcRequest.abortSignal === 'function' ? rpcRequest.abortSignal(signal) : rpcRequest;
  const result = (await Promise.resolve(bound)) as RpcResult<T>;
  if (signal.aborted) throw abortError();
  if (result.error) throw rpcError(result.error, 'The export service returned an error.');
  return result.data;
}

/**
 * Fetch one immutable server-prepared export. A file is only returned when the
 * client received exactly the announced number of unique rows. The short-lived
 * server copy is deleted after success, failure, or cancellation.
 */
export async function fetchClubDataExport<Row>(
  options: FetchClubDataExportOptions<Row>
): Promise<Row[]> {
  const pageSize = Math.max(1, Math.min(options.pageSize ?? 1000, 2000));
  let exportId: string | null = null;
  options.onProgress?.({ stage: 'preparing', loaded: 0, total: null });

  try {
    const started = await request<StartPayload>(
      options.rpc(options.startRpc, {
        ...options.startArgs,
        p_request_id: options.requestId,
      }),
      options.signal
    );
    exportId = typeof started?.export_id === 'string' ? started.export_id : null;
    const total = Number(started?.total_rows);
    if (!exportId || started?.status !== 'ready' || !Number.isInteger(total) || total < 0) {
      throw new Error('The export service returned an invalid preparation receipt.');
    }

    const rows: Row[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let hasMore = total > 0;
    options.onProgress?.({ stage: 'downloading', loaded: 0, total });

    while (hasMore) {
      const page = await request<PagePayload<Row>>(
        options.rpc('ca_club_data_export_page', {
          p_export_id: exportId,
          p_offset: offset,
          p_limit: pageSize,
        }),
        options.signal
      );
      if (!page || !Array.isArray(page.rows) || Number(page.total_rows) !== total) {
        throw new Error('The export changed while it was being downloaded.');
      }
      const nextOffset = Number(page.next_offset);
      if (!Number.isInteger(nextOffset) || nextOffset < offset || nextOffset > total) {
        throw new Error('The export service returned an invalid continuation.');
      }
      if (page.rows.length === 0 && Boolean(page.has_more)) {
        throw new Error('The export stopped before every row was delivered.');
      }

      for (const row of page.rows) {
        const key = options.rowKey(row);
        if (!key || seen.has(key)) {
          throw new Error('The export contained a duplicate or unidentified row.');
        }
        seen.add(key);
        rows.push(row);
      }
      offset = nextOffset;
      hasMore = Boolean(page.has_more);
      options.onProgress?.({ stage: 'downloading', loaded: rows.length, total });
    }

    if (rows.length !== total || offset !== total) {
      throw new Error(`The export delivered ${rows.length} of ${total} rows.`);
    }
    return rows;
  } finally {
    if (exportId) {
      try {
        await Promise.resolve(options.rpc('ca_club_data_export_cancel', { p_export_id: exportId }));
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
