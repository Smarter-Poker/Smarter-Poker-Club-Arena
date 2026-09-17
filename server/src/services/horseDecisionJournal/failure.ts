/** Node exposes SQLite's numeric result separately from private error text.
 * Only BUSY/LOCKED (including their extended codes) are retryable here. */
export function horseJournalFailureKind(error: unknown): 'RETRYABLE' | 'UNAVAILABLE' {
  const e = error as { code?: unknown; errcode?: unknown } | null;
  return e?.code === 'ERR_SQLITE_ERROR' &&
    typeof e.errcode === 'number' &&
    Number.isSafeInteger(e.errcode) &&
    e.errcode >= 0 &&
    e.errcode <= 0x7fffffff &&
    [5, 6].includes(e.errcode & 255)
    ? 'RETRYABLE'
    : 'UNAVAILABLE';
}
