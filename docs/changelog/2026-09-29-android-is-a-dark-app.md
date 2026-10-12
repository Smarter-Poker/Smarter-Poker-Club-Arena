# 2026-09-29 - Android is a dark app on every phone (first on-device run)

Club Arena ran as a native Android app for the first time on 2026-09-28, on an
emulator. It booted, rendered the login console, served its bundled assets and
routed itself to `/auth` in-app - phases 1 and 2 verified on hardware rather
than assumed. It also showed one defect immediately, which is the point of
running it.

## White bars around a black app

The status bar and the navigation bar painted WHITE around the console. On the
premium chassis that reads as broken, and a store reviewer screenshots it.

The cause is Capacitor's template, untouched since `npx cap add android`:

    <style name="AppTheme.NoActionBar" parent="Theme.AppCompat.DayNight.NoActionBar">

`DayNight` follows the PHONE's light/dark setting. The emulator was in light
mode, so the system painted light bars. Every player whose phone is in light
mode - most of them - would have seen the same thing.

## Why the obvious fix does nothing

`src/lib/nativeShell.ts` already calls `StatusBar.setBackgroundColor('#0a0a1a')`
and `setOverlaysWebView(true)`, and the logcat shows both delivered to the
plugin without error:

    V Capacitor: pluginId: StatusBar, methodName: setBackgroundColor,
      methodData: {"color":"#0a0a1a"}

They are accepted and then ignored. From Android 15, an app targeting SDK 35 or
later runs edge-to-edge by force and `Window.setStatusBarColor` is a documented
no-op; we target 36. So the JS call cannot work, cannot fail loudly, and
anybody debugging this from the web side finds a healthy-looking call and no
explanation.

The bars belong to the THEME now. `AppTheme.NoActionBar` gets a dark parent,
the app's own ground painted behind the bars via `android:windowBackground`,
and `windowLightStatusBar` / `windowLightNavigationBar` set false so both sets
of icons are light. `colors.xml` gains `clubArenaGround`, the same `#0a0a1a`
that `capacitor.config.ts` gives the splash and the webview, so the ground is
declared once per layer and cannot drift.

Verified by rebuilding, reinstalling and re-screenshotting the emulator: dark
bars, app edge-to-edge in its own ground.

## The test

`tests/unit/androidIsADarkApp.test.ts` pins the dark parent, the window
background, both light-bar flags, and that the ground colour agrees across
`styles.xml`, `colors.xml` and `capacitor.config.ts`. Proven to bite before
being trusted: restoring the `DayNight` parent fails it with the reason.

This is a resource-file pin rather than a behavioural test on purpose - there
is no runtime here to exercise, the artifact IS the XML, and the failure it
guards against is invisible until someone builds and looks at a phone.
