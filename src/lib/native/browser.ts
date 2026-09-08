/**
 * The in-app browser. Loaded only from src/lib/openExternal.ts, only when the
 * Capacitor bridge says we are native. SFSafariViewController on iOS, a Chrome
 * Custom Tab on Android: the app stays mounted underneath, every open table
 * keeps dealing, and the player closes the sheet to come back.
 */
export async function openInAppBrowser(url: string): Promise<void> {
  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'popover', toolbarColor: '#0a0a1a' });
}
