/** Only these fixed categories may leave the authenticated appearance callback. */
export type ThemeRealtimeReason =
  | 'none'
  | 'timeout'
  | 'jwt'
  | 'signer'
  | 'rls'
  | 'rate'
  | 'config'
  | 'unknown';
export const THEME_REALTIME_DIAGNOSTIC_EVENT = 'table-art-realtime-diagnostic';
export function themeRealtimeDiagnostic(status: string, error?: unknown) {
  const safeStatus = ['SUBSCRIBED', 'CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)
    ? status
    : 'UNKNOWN';
  // Inspect in memory only. Never copy a provider message or arbitrary code into evidence.
  const message = error instanceof Error ? error.message : '';
  let reason: ThemeRealtimeReason = safeStatus === 'SUBSCRIBED' ? 'none' : 'unknown';
  if (safeStatus !== 'SUBSCRIBED') {
    if (/JwtSignerError|jwt signer|jwks/i.test(message)) reason = 'signer';
    else if (/jwt|token expired|signature/i.test(message)) reason = 'jwt';
    else if (/RlsPolicyError|row.level security|Unauthorized/i.test(message)) reason = 'rls';
    else if (/rate.?limit|too many|Max.*Channels|ChannelRateLimit/i.test(message)) reason = 'rate';
    else if (
      /RealtimeDisabled|TenantNotFound|TopicNameRequired|PrivateOnly|configuration/i.test(message)
    )
      reason = 'config';
    else if (safeStatus === 'TIMED_OUT' || /timeout|timed out/i.test(message)) reason = 'timeout';
  }
  return { status: safeStatus, reason };
}
export function emitThemeRealtimeDiagnostic(status: string, error?: unknown): void {
  if (typeof window !== 'undefined')
    window.dispatchEvent(
      new CustomEvent(THEME_REALTIME_DIAGNOSTIC_EVENT, {
        detail: themeRealtimeDiagnostic(status, error),
      })
    );
}
