# 2026-09-29 - An app bundle cannot ship without its backend

Found on the first on-device walkthrough (Android emulator). A native build
booted to "Loading Failed"; the log said `supabaseUrl is required`. The
checkout it was built from had no `.env` (a git worktree does not copy
untracked files), and `npm run build:native` reported success anyway, so the
bundle it produced could not reach anything. On a phone that is an app that
opens to an error and stays there - and the same bundle is what the
`publish-to-app` job uploads over the air to every installed copy.

## The fix

`scripts/native/require-native-backend.mjs`, called from `vite.config.ts`
whenever `VITE_NATIVE=1`, refuses to build a native bundle unless
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` are present, and the URL is
an https URL. It reads the same variables Vite reads (the `.env` files, then
the environment, which wins, as it does for Vite), so it guards every path to
a native bundle at once: `npm run build:native`, `npm run android:bundle`,
`npm run ios:archive`, and the Capgo OTA job (which sets both explicitly and
is unaffected). The message says what to do: build from a checkout with a
`.env`, or export the variables.

The web build is deliberately not guarded: CI builds the web bundle in jobs
that never talk to a backend, and the website has its own deploy checks.

## Tests

`tests/unit/nativeBundleNeedsItsBackend.test.ts` pins the problem list and
runs Vite itself with `VITE_NATIVE=1` and both values empty: it must exit
non-zero with the refusal before building anything. Verified by hand as well:
the same command in a checkout with no `.env` now stops at config time with
the refusal, where it used to produce the broken bundle.
