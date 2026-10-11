/** A committed hand must read absolute stack truth before leaving its barrier.
 * Transport failure cannot undo the commit. Retry only this read, never the
 * settlement or an add-on; lost authority discards every late result. */
export type StackReadResult = {
  data: Array<{ user_id: unknown; stack: unknown }> | null;
  error: unknown;
};

/** These API failures happen before SQL execution. Recognise the exact
 * wrapped messages too: loadTable preserves the message but drops the code. */
export function isPreExecutionDbUnavailable(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  if (['PGRST001', 'PGRST002', 'PGRST003'].includes(String(value?.code))) return true;
  if (value?.code) return false;
  return /Could not query the database for the schema cache|Timed out acquiring connection from connection pool|Database connection error/i.test(
    String(value?.message ?? error)
  );
}

export function transientStackReadError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = value?.code;
  if (isPreExecutionDbUnavailable(error)) return true;
  if (String(code).startsWith('PGRST') || code === '42501') return false;
  if (['57014', '08000', '08003', '08006'].includes(String(code))) return true;
  return /supabase_timeout|fetch failed|Failed to fetch|network|connection reset|socket hang up|timed out acquiring connection/i.test(
    String(value?.message ?? error)
  );
}

export async function readCommittedSeatStacks(options: {
  read: () => PromiseLike<StackReadResult>;
  canReflect: () => boolean;
  progress: () => void;
  sleep: (ms: number) => Promise<void>;
  report: (error: unknown, attempt: number) => void;
  now?: () => number;
}): Promise<StackReadResult['data']> {
  const now = options.now ?? Date.now;
  // One bounded continuation of this hand, no detached worker or repair timer.
  const deadline = now() + 60_000;
  let attempt = 0;
  while (options.canReflect()) {
    attempt++;
    let result: StackReadResult;
    try {
      result = await options.read();
    } catch (error) {
      result = { data: null, error };
    }
    if (!options.canReflect()) return null;
    if (!result.error) {
      if (!Array.isArray(result.data)) throw new Error('Committed stack read returned no row set');
      for (const row of result.data) {
        if (
          typeof row.user_id !== 'string' ||
          (typeof row.stack !== 'number' && typeof row.stack !== 'string') ||
          String(row.stack).trim() === '' ||
          !Number.isFinite(Number(row.stack))
        )
          throw new Error('Committed stack read returned malformed stack truth');
      }
      return result.data;
    }
    options.report(result.error, attempt);
    if (!transientStackReadError(result.error) || now() >= deadline) throw result.error;
    options.progress();
    await options.sleep(
      Math.min(150 * 2 ** Math.min(attempt - 1, 5), 5_000, Math.max(0, deadline - now()))
    );
  }
  return null;
}
