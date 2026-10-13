import { expect, it } from 'vitest';
import { themeRealtimeDiagnostic } from '../../src/utils/themeRealtimeDiagnostic';
it.each([
  ['JwtSignerError', 'signer'],
  ['InvalidJWTExpiration', 'jwt'],
  ['RlsPolicyError', 'rls'],
  ['ChannelRateLimitReached', 'rate'],
  ['RealtimeDisabledForTenant', 'config'],
  ['connection timed out', 'timeout'],
  ['raw unknown provider body bearer secret', 'unknown'],
])('classifies %s without retaining its provider body', (message, reason) => {
  expect(themeRealtimeDiagnostic('CHANNEL_ERROR', new Error(message))).toEqual({
    status: 'CHANNEL_ERROR',
    reason,
  });
});
it('preserves explicit timeout, unknown and successful statuses', () => {
  expect(themeRealtimeDiagnostic('TIMED_OUT')).toEqual({ status: 'TIMED_OUT', reason: 'timeout' });
  expect(themeRealtimeDiagnostic('CLOSED', { message: 'secret' })).toEqual({
    status: 'CLOSED',
    reason: 'unknown',
  });
  expect(themeRealtimeDiagnostic('untrusted')).toEqual({ status: 'UNKNOWN', reason: 'unknown' });
  expect(themeRealtimeDiagnostic('SUBSCRIBED', new Error('JwtSignerError'))).toEqual({
    status: 'SUBSCRIBED',
    reason: 'none',
  });
});
