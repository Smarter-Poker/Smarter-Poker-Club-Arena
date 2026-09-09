# 2026-09-08 - The app has its artwork, and a merge reaches installed phones (store readiness, phase 6)

Audit tier 0, "Generate the icon and splash set" and the OTA section, "Wire
Capgo from launch" (Dan, phase 0: yes).

## Artwork

There was one 1024x1024 logo (`public/poker-chip-logo.png`, a JPEG despite
its name) and no icon or splash set. `scripts/native/make-resources.mjs`
turns it into the two inputs `@capacitor/assets` wants - `resources/icon.png`
(1024x1024, flattened onto `#0a0a1a`; iOS refuses alpha in an app icon) and
`resources/splash.png` (2732x2732, the logo at ~40% of the short side so it
survives every phone's crop) - and `npm run cap:assets` writes 87 Android and
10 iOS files from them. Everything is committed (15.5 MB), because a binary
has to be cut from a clean checkout.

`cap:assets` is now pinned to `--ios --android`. Unpinned, the generator also
rewrote `public/manifest.json`, dropped seven PWA icons into `public/assets/`
and reformatted `AndroidManifest.xml`; the first two would have changed the
web bundle, which this whole programme promised not to do. Reverted here and
prevented by the flag; `tests/unit/nativeAssetsAndOta.test.ts` pins it.

## OTA

`publish-club-arena.yml` gains `publish-to-app`, a job in the ONE publisher
(the `no-commit-left-behind` law still counts one workflow with a
`publish-to-origin` job). It needs the same build and the same test shards
as the origin publish, and runs only after the origin was verified serving
the commit, so the app can never be ahead of the web. It builds
`dist-native` and uploads it to Capgo's `production` channel; installed apps
pick it up on their next launch.

The bundle version is `<native.version>.<run number>`. `native.version`
(`1.0`) is the binary's marketing version, pinned by the same test to iOS
`MARKETING_VERSION` and Android `versionName`, and the run number is
monotonic - so every upload is unique, ordered, and never below the binary
that installs it (Capgo refuses a bundle older than the app).

`CAPGO_TOKEN` does not exist yet (Dan, 10.84). The job is switched on by the
repository variable `CAPGO_OTA_ENABLED=true` in its job-level `if` (a
job-level `if` can read variables, not secrets), so today it is skipped and
this merges doing nothing; the day the secret and the variable are set, the
next publish ships OTA with no further change. The switch on with no token
fails loudly - a misconfiguration is not a quiet no-op. The job sits above
`publish-to-origin` in the file only because the no-commit-left-behind law
reads everything after the Converge step as that step; `needs` is what orders
execution, and it needs the origin publish. The RevenueCat public SDK keys are read from secrets in
the same job so the OTA bundle carries them once they exist.

## Verified

- `tests/unit/nativeAssetsAndOta.test.ts` (PNG dimensions read from the IHDR,
  the committed outputs, the version pin across three files, the job's
  gating) and `tests/no-commit-left-behind.law.test.ts` green.
- The workflow parses. The Capgo upload itself cannot be exercised without
  the account; the CLI flags are the documented `bundle upload` set.
- Web: no file under `public/` or `src/` changes on this branch.
