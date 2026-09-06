import { describe, expect, it } from 'vitest';

import {
  isSentryEnvelopeRateLimitConsoleError,
  type ProductionConsoleError,
} from '../e2e/support/productionConsoleErrorPolicy';

const SENTRY_ENVELOPE_URL =
  'https://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/envelope/' +
  '?sentry_version=7&sentry_key=842977a65e398b038728a05e8d892089' +
  '&sentry_client=sentry.javascript.react%2F10.38.0';
const OTHER_HTTP_ERROR_STATUSES = Array.from({ length: 200 }, (_, index) => 400 + index).filter(
  (status) => status !== 429
);

function resourceError(status: number, url = SENTRY_ENVELOPE_URL): ProductionConsoleError {
  return {
    text: `Failed to load resource: the server responded with a status of ${status} ()`,
    url,
  };
}

describe('production console error policy', () => {
  it('classifies only the observed production Sentry envelope 429 as collector backpressure', () => {
    expect(isSentryEnvelopeRateLimitConsoleError(resourceError(429))).toBe(true);
  });

  it.each(OTHER_HTTP_ERROR_STATUSES)('keeps Sentry envelope HTTP %i critical', (status) => {
    expect(isSentryEnvelopeRateLimitConsoleError(resourceError(status))).toBe(false);
  });

  it.each([
    ['another Sentry project', 'https://o4510810580779008.ingest.us.sentry.io/api/999/envelope/'],
    [
      'another Sentry organization',
      'https://o9999999999999999.ingest.us.sentry.io/api/4510816835600384/envelope/',
    ],
    [
      'another Sentry region',
      'https://o4510810580779008.ingest.sentry.io/api/4510816835600384/envelope/',
    ],
    [
      'a Sentry host lookalike',
      'https://o4510810580779008.ingest.us.sentry.io.example.test/api/4510816835600384/envelope/',
    ],
    [
      'a Sentry URL hidden in another origin query',
      'https://smarter.poker/failure?url=https://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/envelope/',
    ],
    [
      'the legacy Sentry store endpoint',
      'https://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/store/',
    ],
    [
      'the envelope endpoint without its canonical trailing slash',
      'https://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/envelope',
    ],
    [
      'a child of the envelope endpoint',
      'https://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/envelope/extra',
    ],
    [
      'the envelope endpoint on another port',
      'https://o4510810580779008.ingest.us.sentry.io:444/api/4510816835600384/envelope/',
    ],
    [
      'a Sentry vendor asset',
      'https://smarter.poker/hub/club-arena/assets/vendor-sentry-CXXob-UT-v6.js',
    ],
    [
      'the exact Sentry path over HTTP',
      'http://o4510810580779008.ingest.us.sentry.io/api/4510816835600384/envelope/',
    ],
  ])('keeps a 429 from %s critical', (_case, url) => {
    expect(isSentryEnvelopeRateLimitConsoleError(resourceError(429, url))).toBe(false);
  });

  it.each([
    ['Supabase REST', 'https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/club_members?select=id'],
    [
      'Supabase RPC',
      'https://kuklfnapbkmacvwxktbh.supabase.co/rest/v1/rpc/get_cashier_reconciliation',
    ],
    ['the app API', 'https://smarter.poker/api/cashier/reconcile'],
    ['an app asset', 'https://smarter.poker/hub/club-arena/assets/index-abc123.js'],
    ['a CDN asset', 'https://cdn.example.test/club-arena/card-back.webp'],
  ])('keeps a 429 from %s critical', (_case, url) => {
    expect(isSentryEnvelopeRateLimitConsoleError(resourceError(429, url))).toBe(false);
  });

  it.each([
    ['an empty URL', ''],
    ['a malformed URL', 'not a URL'],
  ])('keeps a 429 with %s critical', (_case, url) => {
    expect(isSentryEnvelopeRateLimitConsoleError(resourceError(429, url))).toBe(false);
  });

  it.each([
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Failed to load resource: net::ERR_FAILED',
    'Sentry responded with status code 429 to sent event.',
  ])('keeps non-resource-failure text critical: %s', (text) => {
    expect(
      isSentryEnvelopeRateLimitConsoleError({
        text,
        url: SENTRY_ENVELOPE_URL,
      })
    ).toBe(false);
  });
});
