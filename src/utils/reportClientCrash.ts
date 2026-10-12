/**
 * WHERE A RENDER CRASH IS RECORDED (launch audit 2026-10-06).
 *
 * The error boundaries wrote `client_crash_log` straight from the browser.
 * Read on production: that table grants INSERT to `service_role` and
 * `postgres` only, so every one of those inserts was refused, inside a
 * try/catch that exists so reporting can never throw. The table held rows
 * from the World Hub's boundaries ('auth', 'hub', 'page') and not one from
 * Club Arena: a crash at a live table or on any Club Arena page left no
 * record at all, and looked like it did.
 *
 * The World Hub already runs the sink a browser is allowed to use,
 * `POST /api/client-crash`, which writes the row with the service role behind
 * a rate limit. Club Arena is served from the same origin, so the boundaries
 * post there. It accepts the boundaries 'hub' and 'page'; Club Arena's rows
 * are 'page' with a section that names the surface.
 *
 * Reporting a crash must never itself throw, and never waits on the network
 * for the fallback to paint.
 */
export interface ClientCrashReport {
  /** Names the surface, e.g. "club-arena-table:TablePage". */
  section: string;
  error: unknown;
  componentStack?: string | null;
}

export async function reportClientCrash(report: ClientCrashReport): Promise<boolean> {
  try {
    if (typeof window === 'undefined' || typeof fetch !== 'function') return false;
    const err = report.error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    let userId: string | null = null;
    try {
      const { readLocalSession } = await import('../lib/authUtils');
      userId = readLocalSession()?.userId ?? null;
    } catch {
      /* an anonymous crash is still worth recording */
    }
    const response = await fetch('/api/client-crash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        boundary: 'page',
        section: String(report.section).slice(0, 120),
        route: window.location.pathname,
        url: window.location.href,
        errorName: typeof err?.name === 'string' ? err.name : 'Error',
        message: String(err?.message ?? report.error ?? 'unknown').slice(0, 1000),
        stack: typeof err?.stack === 'string' ? err.stack.slice(0, 6000) : null,
        componentStack: report.componentStack ? String(report.componentStack).slice(0, 6000) : null,
        userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
        userId,
        embedded: window.self !== window.top,
        buildSha:
          (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BUILD_SHA ?? null,
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
