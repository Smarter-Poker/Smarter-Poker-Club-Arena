export type ProductionConsoleError = Readonly<{
  text: string;
  url: string;
}>;

const SENTRY_INGEST_ORIGIN = 'https://o4510810580779008.ingest.us.sentry.io';
const SENTRY_ENVELOPE_PATH = '/api/4510816835600384/envelope/';
const SENTRY_RATE_LIMIT_RESOURCE_ERROR =
  /^Failed to load resource: the server responded with a status of 429(?: \([^)]*\))?$/;

/**
 * Sentry's browser transport observes a 429 and backs off future envelopes,
 * but Chromium also emits the rejected telemetry POST as a console error.
 * That collector backpressure is not a failed Club Arena resource.
 *
 * Keep this exception exact. A broad 429 or Sentry exemption would hide real
 * application, Supabase, CDN, DSN, and telemetry-initialization failures from
 * the production Cashier gates.
 */
export function isSentryEnvelopeRateLimitConsoleError(entry: ProductionConsoleError): boolean {
  if (!SENTRY_RATE_LIMIT_RESOURCE_ERROR.test(entry.text.trim())) return false;

  try {
    const url = new URL(entry.url);
    return url.origin === SENTRY_INGEST_ORIGIN && url.pathname === SENTRY_ENVELOPE_PATH;
  } catch {
    return false;
  }
}
