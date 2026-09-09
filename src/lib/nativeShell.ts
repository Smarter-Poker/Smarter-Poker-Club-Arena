/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  NATIVE SHELL — what the Capacitor app does that a browser tab does for free
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Loaded by main.tsx ONLY in a native build (IS_NATIVE_BUILD, via a dynamic
 * import), so none of this - and none of the Capacitor plugin code it pulls in -
 * exists in the web bundle. Every call here is best-effort: the shell must
 * never be the reason a table fails to paint.
 *
 * What it owns:
 *   - the splash screen: capacitor.config.ts sets launchAutoHide:false so a
 *     slow cold boot shows the logo, not a white flash. We hide it once React
 *     has painted.
 *   - the status bar: dark, overlaying the webview (the app paints its own
 *     safe areas).
 *   - Capgo: notifyAppReady() MUST be called on every launch or the updater
 *     treats the bundle as broken and rolls back to the previous one.
 *   - Android hardware back: history.back() inside the app, minimise at root.
 *   - deep links: appUrlOpen and the launch URL go to src/lib/native/deepLinks.
 *   - the session mirror (src/lib/native/sessionMirror) is started after boot.
 *   - push: the plugin listeners are attached at boot (src/lib/native/push)
 *     so a tap on a notification that cold-started the app is routed, and the
 *     cached permission state pushClient.ts reads synchronously is primed.
 *   - foreground: appStateChange -> isActive resumes every AudioContext the
 *     app created (src/lib/audioContexts). iOS moves them to 'interrupted'
 *     during a phone call and does not always fire visibilitychange after.
 *
 * CHANGELOG: docs/changelog/2026-09-07-capacitor-shell.md
 */

import { isNativePlatform, nativePlatform } from './appBase';

let started = false;

/** Called from main.tsx right after root.render(). Safe to call once. */
export async function initNativeShell(): Promise<void> {
  if (started) return;
  started = true;
  if (!isNativePlatform()) return;

  await Promise.allSettled([
    hideSplashAfterPaint(),
    styleStatusBar(),
    markUpdaterReady(),
    wireBackButton(),
    wireDeepLinks(),
    mirrorSession(),
    wirePush(),
    wireForeground(),
  ]);
}

async function hideSplashAfterPaint(): Promise<void> {
  const { SplashScreen } = await import('@capacitor/splash-screen');
  // Two frames: one for React's commit, one for the compositor.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
  await SplashScreen.hide({ fadeOutDuration: 200 });
}

async function styleStatusBar(): Promise<void> {
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  await StatusBar.setStyle({ style: Style.Dark });
  if (nativePlatform() === 'android') {
    await StatusBar.setBackgroundColor({ color: '#0a0a1a' });
    await StatusBar.setOverlaysWebView({ overlay: true });
  }
}

async function markUpdaterReady(): Promise<void> {
  const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
  await CapacitorUpdater.notifyAppReady();
}

async function wireDeepLinks(): Promise<void> {
  const [{ App }, { handleAppUrl }] = await Promise.all([
    import('@capacitor/app'),
    import('./native/deepLinks'),
  ]);
  await App.addListener('appUrlOpen', ({ url }) => {
    void handleAppUrl(url);
  });
  // A cold start from a link: the event may have fired before this listener
  // existed, so ask for the launch URL as well. handleAppUrl de-duplicates.
  const launch = await App.getLaunchUrl();
  if (launch?.url) void handleAppUrl(launch.url);
}

async function wireForeground(): Promise<void> {
  const [{ App }, { resumeTrackedAudioContexts }] = await Promise.all([
    import('@capacitor/app'),
    import('./audioContexts'),
  ]);
  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) resumeTrackedAudioContexts();
  });
}

async function wirePush(): Promise<void> {
  const [{ initNativePush }, { primeNativePushState }] = await Promise.all([
    import('./native/push'),
    import('./pushClient'),
  ]);
  await initNativePush();
  await primeNativePushState();
}

async function mirrorSession(): Promise<void> {
  const { startSessionMirror } = await import('./native/sessionMirror');
  await startSessionMirror();
}

async function wireBackButton(): Promise<void> {
  if (nativePlatform() !== 'android') return;
  const { App } = await import('@capacitor/app');
  await App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack && window.history.length > 1) {
      window.history.back();
    } else {
      void App.minimizeApp();
    }
  });
}
