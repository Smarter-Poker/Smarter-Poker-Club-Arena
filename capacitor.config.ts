import type { CapacitorConfig } from '@capacitor/cli';

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CAPACITOR SHELL — Club Arena as an iOS / Android app
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The shell is deliberately THIN. It copies dist-native/ (npm run build:native,
 * base '/') into the binary and hands everything else to the same React tree
 * the web ships. A binary is cut when a plugin, a permission or the minimum OS
 * changes; every other change reaches players through Capgo OTA
 * (docs/changelog/2026-09-07-capacitor-shell.md).
 *
 * The web build is untouched by this file: it is read by `cap sync` only.
 */
const config: CapacitorConfig = {
  appId: 'poker.smarter.clubarena',
  appName: 'Club Arena',
  webDir: 'dist-native',
  // The webview serves the bundle from https://localhost on Android and
  // capacitor://localhost on iOS. Both are first-party origins for the
  // Supabase redirect allow-list (Phase 2).
  server: {
    androidScheme: 'https',
    iosScheme: 'capacitor',
  },
  ios: {
    // The app paints its own safe-area padding (287 declarations, 114 files);
    // letting the webview inset as well would double it.
    contentInset: 'never',
    backgroundColor: '#0a0a1a',
    // A poker table must never be cut off by a scroll bounce.
    scrollEnabled: false,
    preferredContentMode: 'mobile',
  },
  android: {
    backgroundColor: '#0a0a1a',
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      // The app dismisses the splash itself once React has painted, so a slow
      // cold boot shows the logo rather than a white flash (src/lib/nativeShell.ts).
      launchAutoHide: false,
      launchShowDuration: 0,
      backgroundColor: '#0a0a1a',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0a0a1a',
      overlaysWebView: true,
    },
    Keyboard: {
      resize: 'none',
    },
    CapacitorUpdater: {
      // OTA (Capgo). autoUpdate is on so a merged web change reaches every
      // installed app on next launch without a store review. The channel and
      // the app id are set in the Capgo console (Dan's account, Phase 6).
      autoUpdate: true,
      resetWhenUpdate: true,
    },
  },
};

export default config;
