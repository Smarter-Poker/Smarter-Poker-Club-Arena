# 2026-09-29 - Over-the-air updates send only what changed

Measured while building the Android app for the device walkthrough: the app
bundle (`dist-native`) is ~172 MB across 1,951 files - 92 MB of images and
62 MB of hashed assets, most of which do not change between releases.

`publish-to-app` uploaded that bundle to Capgo as one zip, and the job runs on
every merge to `main` (several a day). With `autoUpdate: true` every installed
copy of the app would then have downloaded the whole 172 MB again after each
merge - over cellular, several times a day - and every download counts against
the Capgo plan's bandwidth.

## The change

- `bundle upload --delta`: Capgo stores the bundle file by file and a phone
  downloads only the files whose content changed, typically the few JavaScript
  and CSS chunks a merge touched. Verified against the pinned CLI's own help
  (`@capgo/cli@8.68.1`): `--delta` is the current flag (`--partial` is its
  deprecated name), it refuses bundles over 10,000 files and paths with
  spaces; `dist-native` has 1,951 files and no spaces.
- The CLI is pinned to its major (`@capgo/cli@8`) instead of `@latest`, so a
  breaking CLI release cannot turn every publish red overnight.

`tests/unit/nativeAssetsAndOta.test.ts` now pins both. The job is still off
until `CAPGO_OTA_ENABLED` and `CAPGO_TOKEN` exist (Dan's), so nothing changes
for the web publish.

## Not changed, flagged

Bundles are still uploaded with `--no-key` (not signed). Capgo supports
end-to-end signing: a public key in `capacitor.config.ts` and the private key
as a CI secret, so a phone refuses any bundle the pipeline did not sign. That
needs a key pair whose private half is a credential (CLAUDE.md 10.84), so it
is Dan's to create; the wiring is a few lines once it exists.
