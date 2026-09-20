/** Local engine diagnostics. Reporting never interrupts the caller's work. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return String(error);
  if (typeof error === 'object') {
    const e = error as Record<string, any>;
    const head = e.message || e.error_description || e.details || e.hint || e.error || null;
    const code = e.code ? ` (${e.code})` : '';
    if (head) return `${String(head)}${code}`;
    try {
      return `${JSON.stringify(error)}`;
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

export function reportError(error: unknown, context: string, extra?: Record<string, any>): void {
  try {
    if (extra === undefined) console.error(`[${context}]`, error);
    else console.error(`[${context}]`, error, extra);
  } catch {
    // A broken stderr pipe must not unwind an engine loop or its catch handler.
  }
}

export function reportWarning(message: string, context: string, data?: Record<string, any>): void {
  try {
    if (data === undefined) console.warn(`[${context}] ${message}`);
    else console.warn(`[${context}] ${message}`, data);
  } catch {
    // A broken stderr pipe must not replace the original result.
  }
}
