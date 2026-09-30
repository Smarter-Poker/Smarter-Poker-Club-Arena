# 2026-09-29 - An app bundle cannot ship without its backend

Found on the first on-device walkthrough (Android emulator). A native build
booted to "Loading Failed"; the log said `supabaseUrl is required`. The
checkout it was built from had no `.env` (a git worktree does not copy
untracked files), and `npm run build:native` reported success anyway, so the
bundle it produced could not reach anything. On a phone that is an app that
opens to an error and stays there - and the same bundle is what the
`publish-to-app` job uploads over the air to every installed copy.

## The fix

`npm run build:native` now runs `scripts/native/require-native-backend.mjs`
FIRST, and it refuses to build unless `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` are present and the URL is an https URL. It reads the
same variables Vite reads (the `.env` files, then the environment, which wins,
as it does for Vite), so it guards every path to an installable bundle at
once: `npm run build:native`, `npm run android:bundle`, `npm run ios:archive`,
and the Capgo OTA job (which sets both explicitly and is unaffected). The
message says what to do: build from a checkout with a `.env`, or export the
variables. Verified by hand: `npm run build:native` in a checkout with no
`.env` now stops at once with the refusal and writes no `dist-native/`.

It is deliberately NOT in `vite.config.ts`. The first cut put it there, and
CI showed why that is wrong: `tests/unit/hiddenSourceMaps.test.ts` loads the
config with `VITE_NATIVE=1` to inspect it, and a config that throws without a
backend failed that test for no reason. The guard belongs on the path that
produces a bundle, not on reading a config.

The web build is deliberately not guarded: CI builds the web bundle in jobs
that never talk to a backend, and the website has its own deploy checks.

## Tests

`tests/unit/nativeBundleNeedsItsBackend.test.ts` pins the problem list, runs
the guard script with both values empty (exit 1 with the refusal) and with
both present (exit 0), and pins that `build:native` runs it first.
