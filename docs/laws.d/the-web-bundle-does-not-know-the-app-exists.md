# tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts

Club Arena builds for two targets from one tree: the web sub-path
`/hub/club-arena/` and the Capacitor app at the native root. Every difference
between them is gated on the single compile-time constant `VITE_NATIVE=1`
(`npm run build:native`, output `dist-native/`), the router basename is
derived from `BASE_URL` in both entry points rather than written as a literal
(a mismatched basename is a white screen, not a 404), and Capacitor plugin code
is reached only through `src/lib/nativeShell.ts` behind a dynamic import. So
the web bundle is byte-for-byte what it was before the app existed, and the
publisher can never ship the native bundle by mistake.
