/**
 * Club Arena is a dark app on every phone, whatever the phone's own setting.
 *
 * WHY THIS EXISTS. The first Android build (2026-09-28, on an emulator) booted
 * with WHITE status and navigation bars framing the black console UI. The
 * cause was not our code: Capacitor's template ships
 * `Theme.AppCompat.DayNight.NoActionBar` for AppTheme.NoActionBar, and
 * DayNight follows the PHONE's light/dark setting - so every player with their
 * phone in light mode would have got white bars.
 *
 * What makes this worth a test rather than a one-line fix: it CANNOT be fixed
 * from the web bundle, and the code that looks like it fixes it silently does
 * nothing. From Android 15 (targetSdk 35+, and we target 36) edge-to-edge is
 * enforced and `Window.setStatusBarColor` is a no-op, so
 * `StatusBar.setBackgroundColor('#0a0a1a')` in src/lib/nativeShell.ts is
 * accepted by the plugin, logged as delivered, and ignored by the platform.
 * Anyone debugging this from the JS side finds nothing wrong.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/** The app's ground. One colour, everywhere it is declared. */
const GROUND = '#0a0a1a';

describe('the Android theme does not follow the phone into light mode', () => {
  const styles = () => read('android/app/src/main/res/values/styles.xml');

  it('the webview theme has a dark parent, not DayNight', () => {
    const s = styles();
    const block = s.slice(s.indexOf('name="AppTheme.NoActionBar"'));
    const parent = /parent="([^"]+)"/.exec(block)?.[1];
    expect(parent).toBeDefined();
    expect(parent, 'DayNight follows the phone and gives white bars in light mode').not.toMatch(
      /DayNight/
    );
  });

  it('paints its own ground behind the system bars, with light icons on both', () => {
    const s = styles();
    const block = s.slice(s.indexOf('name="AppTheme.NoActionBar"'));
    const end = block.indexOf('</style>');
    const body = block.slice(0, end === -1 ? undefined : end);
    expect(body).toMatch(/android:windowBackground">@color\/clubArenaGround/);
    // The attribute names read backwards: "light status bar" means a LIGHT
    // BAR with dark icons. A dark bar with light icons is false.
    expect(body).toMatch(/android:windowLightStatusBar">false/);
    expect(body).toMatch(/android:windowLightNavigationBar">false/);
  });

  it('the ground is one colour across the theme, the resources and the shell config', () => {
    expect(read('android/app/src/main/res/values/colors.xml')).toMatch(
      new RegExp(`name="clubArenaGround">${GROUND}`, 'i')
    );
    // capacitor.config.ts sets the same ground for the splash and the webview
    expect(read('capacitor.config.ts')).toContain(`backgroundColor: '${GROUND}'`);
  });
});
