import type { Frame, Page, Request, Response } from '@playwright/test';

const LIMIT = 64;
const CODES = new Set([
  'net::ERR_ABORTED',
  'net::ERR_FAILED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_TIMED_OUT',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_HTTP2_PROTOCOL_ERROR',
]);
type Event = {
  kind: 'requestfailed' | 'http-error' | 'navigation';
  ms: number;
  origin: string;
  path: string;
  method: string;
  code?: string;
  status?: number;
};

/** No query, fragment, credentials, headers, body or arbitrary error text survives. */
export function createCashierDiagnostics(now = () => performance.now()) {
  const start = now();
  const events: Event[] = [];
  let dropped = 0;
  return {
    record(kind: Event['kind'], rawUrl: string, method = '', detail?: string | number) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return;
      }
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
      const event: Event = {
        kind,
        ms: Math.max(0, Math.round(now() - start)),
        origin: url.origin.slice(0, 256),
        path: url.pathname.slice(0, 256),
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)
          ? method
          : '',
      };
      if (kind === 'requestfailed')
        event.code = typeof detail === 'string' && CODES.has(detail) ? detail : 'NETWORK_FAILURE';
      if (kind === 'http-error') {
        if (typeof detail !== 'number' || !Number.isInteger(detail) || detail < 400 || detail > 599)
          return;
        event.status = detail;
      }
      if (events.length === LIMIT) {
        events.shift();
        dropped++;
      }
      events.push(event);
    },
    snapshot() {
      return { version: 1, limit: LIMIT, dropped, events: events.map((e) => ({ ...e })) };
    },
  };
}

/** Observe only; this never routes, aborts, retries or changes a request. */
export function observeCashierFailure(page: Page) {
  const log = createCashierDiagnostics();
  const failed = (request: Request) =>
    log.record('requestfailed', request.url(), request.method(), request.failure()?.errorText);
  const response = (response: Response) => {
    if (response.status() >= 400)
      log.record('http-error', response.url(), response.request().method(), response.status());
  };
  const navigated = (frame: Frame) => {
    if (frame === page.mainFrame()) log.record('navigation', frame.url());
  };
  page.on('requestfailed', failed);
  page.on('response', response);
  page.on('framenavigated', navigated);
  return {
    snapshot: log.snapshot,
    stop() {
      page.off('requestfailed', failed);
      page.off('response', response);
      page.off('framenavigated', navigated);
    },
  };
}
