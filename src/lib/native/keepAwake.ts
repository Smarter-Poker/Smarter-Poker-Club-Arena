/**
 * Keep the screen on while a table is dealing (native only). Loaded from
 * src/hooks/useTableEnvironment.ts, only when the Capacitor bridge says
 * native. WKWebView never got navigator.wakeLock, so on iOS the felt used to
 * sleep mid-hand; the plugin sets UIApplication.idleTimerDisabled /
 * FLAG_KEEP_SCREEN_ON directly.
 */
export async function nativeKeepAwake(on: boolean): Promise<void> {
  const { KeepAwake } = await import('@capacitor-community/keep-awake');
  if (on) await KeepAwake.keepAwake();
  else await KeepAwake.allowSleep();
}
