# Club Arena on the App Store and Google Play - the runbook

The Capacitor Readiness Audit (revised 2026-09-04) is the list. This is the
operating manual for shipping it: what is built, what each phase needs from
Dan, and the exact steps to a store listing. Keep it current; it is read by
whoever cuts the next binary.

The audit's phases and where each one lives:

| phase | what                                                                   | where                                                                     |
| ----- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 0     | product and legal decisions                                            | this file, "Dan's rulings"                                                |
| 1     | make it boot (Capacitor shell, native base, asset paths)               | `docs/changelog/2026-09-07-capacitor-shell.md`                            |
| 2     | auth, session, deep links, share links                                 | `docs/changelog/2026-09-07-native-auth-and-links.md`                      |
| 3     | compliance: store billing, age gate, deletion, terms, consent, wording | `docs/changelog/2026-09-08-in-app-purchases.md` (3a) and the 3b changelog |
| 4     | native push (FCM / APNs)                                               | its changelog when built                                                  |
| 5     | feel native: haptics, keep-awake, overscroll, safe areas, exports      | its changelog when built                                                  |
| 6     | icons, splash, OTA, listings, submission                               | this file, "Submission"                                                   |
| 7     | review cycles                                                          | this file, "Review notes"                                                 |

## Dan's rulings (phase 0, 2026-09-07)

- **Chips at review.** "Chips are club play credits. Smarter.Poker does not
  sell, redeem or pay out chips and assigns them no monetary value; any
  arrangement between a member and their club's agent is private and
  off-platform." The Terms line "cannot be exchanged for real money or
  prizes" is dropped. This sentence is the answer to any reviewer question
  about the wallet, the rake or the agent hierarchy.
- **Sign-in in the app: email + password only.** No Apple, Google or Facebook
  in the binary, so Guideline 4.8 (Sign in with Apple) does not apply.
- **OTA from launch, via Capgo.** Binaries are scheduled events - monthly, or
  when a plugin, permission or minimum OS changes.
- **No accounts existed on 2026-09-07.** Every account below is Dan's to
  create; agents never set a credential (CLAUDE.md 10.84).

## Accounts and credentials Dan creates (never an agent)

| account                                                                   | why                                                                                  | where the value goes                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer Program ($99/yr; organisation needs a D-U-N-S, 1-2 weeks) | TestFlight, App Store Connect, signing, universal links                              | Team ID into `ios/App/App/App.entitlements` (Associated Domains) and into the World Hub's `apple-app-site-association`                                                                               |
| Google Play Console ($25 once; identity verification)                     | internal testing, the Play listing, app links                                        | release keystore SHA-256 into the World Hub's `assetlinks.json`                                                                                                                                      |
| Xcode on the Mac (App Store download, ~10 GB)                             | building and archiving iOS; this Mac has only the Command Line Tools                 | nothing to store                                                                                                                                                                                     |
| A JDK 17 or 21 on PATH (Android Studio bundles one)                       | Gradle refuses the Mac's default Java 25 (`Unsupported class file major version 69`) | nothing to store                                                                                                                                                                                     |
| RevenueCat project (free under $2,500/mo)                                 | StoreKit + Play Billing for diamonds and VIP                                         | public SDK keys as `VITE_REVENUECAT_IOS_KEY` / `VITE_REVENUECAT_ANDROID_KEY` in the native build; webhook auth as `REVENUECAT_WEBHOOK_AUTH` in Vercel                                                |
| Firebase project (free)                                                   | FCM for Android push and APNs relay for iOS                                          | `google-services.json` in `android/app/`, `GoogleService-Info.plist` in `ios/App/App/`, an APNs .p8 key uploaded to Firebase; service-account JSON as `FCM_SERVICE_ACCOUNT_JSON` in Vercel (phase 4) |
| Capgo account (~$15/mo)                                                   | OTA updates                                                                          | app id and channel in the Capgo console; `CAPGO_TOKEN` for the publisher (phase 6)                                                                                                                   |
| Supabase dashboard: Auth > URL Configuration                              | provider redirects from the app                                                      | add `capacitor://localhost` and `https://localhost` to the redirect allow-list (email links already use smarter.poker, which is allowed)                                                             |

## Building the app

```bash
npm run build:native          # VITE_NATIVE=1 -> dist-native/ (base '/', no source maps)
npx cap sync                  # copies dist-native/ into ios/ and android/, installs plugins
npx cap open ios              # Xcode (needs Xcode installed)
npx cap open android          # Android Studio
npm run cap:assets            # icons + splash from resources/ (see "Artwork")
```

The web build is untouched by any of this: `npm run build` still produces
`dist/` at `/hub/club-arena/`, and
`tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts` keeps every
native difference behind `VITE_NATIVE=1`.

Identity: appId `poker.smarter.clubarena`, app name "Club Arena", custom
scheme `clubarena://`, webview origins `capacitor://localhost` (iOS) and
`https://localhost` (Android). Portrait only on phones; iPad rotates.

## Store products (phase 3)

Create these EXACT ids in App Store Connect (consumables + auto-renewable
subscriptions) and the Play Console (one-time products + subscriptions), then
attach them to a RevenueCat offering. The database and the client derive the
same ids (`select product_id, kind, price_usd from iap_products`):

```
poker.smarter.clubarena.diamonds.micro      1.00   100 diamonds
poker.smarter.clubarena.diamonds.small      5.00   500
poker.smarter.clubarena.diamonds.medium    10.00  1000
poker.smarter.clubarena.diamonds.standard  25.00  2500
poker.smarter.clubarena.diamonds.large     50.00  5000
poker.smarter.clubarena.diamonds.value    100.00 10000 + 500 bonus
poker.smarter.clubarena.diamonds.premium  250.00 25000 + 1250 bonus
poker.smarter.clubarena.diamonds.whale    500.00 50000 + 2500 bonus
poker.smarter.clubarena.vip.monthly         9.99  auto-renewing, 1 month
poker.smarter.clubarena.vip.yearly         99.99  auto-renewing, 1 year
```

Store prices are set in the store consoles in tiers; the database records
what the webhook reports and the `price_usd` above is the catalogue price.
The webhook: `https://smarter.poker/api/store/webhooks/revenuecat`.

Worth saying plainly, from the audit: revenue through Stripe costs ~3%;
through the stores it costs 15-30%. On a native build that is not optional
for digital goods consumed in the app.

## Deep links (phase 2)

`clubarena://...` works with no store account. The https links need two files
served by the World Hub at `/.well-known/`, both blocked on Dan's accounts:

- `apple-app-site-association` (no extension, `application/json`):
  `{"applinks":{"apps":[],"details":[{"appID":"<TEAMID>.poker.smarter.clubarena","paths":["/hub/club-arena/*"]}]}}`
  plus `com.apple.developer.associated-domains` = `applinks:smarter.poker`
  in `ios/App/App/App.entitlements`.
- `assetlinks.json`:
  `[{"relation":["delegate_permission/common.handle_all_urls"],"target":{"namespace":"android_app","package_name":"poker.smarter.clubarena","sha256_cert_fingerprints":["<RELEASE SHA-256>"]}}]`
  (the intent filter with `autoVerify` is already in `AndroidManifest.xml`).

## Artwork (phase 6) - DONE 2026-09-08

`resources/icon.png` (1024x1024, opaque) and `resources/splash.png`
(2732x2732, the chip logo centred on `#0a0a1a`) are generated from the one
logo the app already ships by `node scripts/native/make-resources.mjs`, and
`npm run cap:assets` (pinned to `--ios --android` so it never touches the web
manifest or `public/`) writes every icon and splash size into `ios/` and
`android/`. All of it is committed, so a binary is cut from a clean checkout.
When the logo changes, run both again and commit the result.

Still needed for the LISTINGS, not the binary: a 512x512 Play icon and a
1024x500 feature graphic (both can be exported from `resources/icon.png`),
and screenshots (iPhone 6.7" and 6.5", iPad 12.9" if iPad is offered; Play
phone + 7" + 10") - taken from a device once one exists.

## Versions

`native.version` (`1.0`) is the binary's marketing version and is pinned by
`tests/unit/nativeAssetsAndOta.test.ts` to iOS `MARKETING_VERSION` and
Android `versionName`. Bump all three together when a new binary is cut. OTA
bundles are versioned `<native.version>.<publish run number>`, so they are
unique, ordered, and never below the binary that installs them.

## OTA (phase 6, Capgo) - WIRED 2026-09-08, waiting on the account

`@capgo/capacitor-updater` is installed, `capacitor.config.ts` has
`autoUpdate: true`, and `nativeShell.ts` calls `notifyAppReady()` on every
launch - Capgo REQUIRES that call or it rolls the bundle back as broken.

`publish-club-arena.yml` has a `publish-to-app` job: after the origin is
verified serving a merge, it builds `dist-native` (`npm run build:native`)
and runs `npx @capgo/cli bundle upload --channel production`. It is switched
on by the repository VARIABLE `CAPGO_OTA_ENABLED=true` (a job-level `if` can
read variables, not secrets); until then the job is skipped and the web
publish is never held by a store account that does not exist. To turn it on:
create the Capgo app with id `poker.smarter.clubarena`, a `production`
channel, an API key with upload rights, set the `CAPGO_TOKEN` secret, then
set the variable (optionally `CAPGO_CHANNEL` too). The switch on with no
token fails the job loudly rather than skipping. The RevenueCat
public SDK keys go in as `VITE_REVENUECAT_IOS_KEY` /
`VITE_REVENUECAT_ANDROID_KEY` secrets so the OTA bundle carries them.

Guideline 3.3.2: OTA JavaScript must not change the app's primary purpose or
add features that skip review; CSS, copy and fixes are fine, a new plugin or
permission is a new binary.

## Privacy answers (phase 3)

Apple's Privacy Nutrition Labels and Play's Data Safety form are answered from
what the app actually collects after phase 3: account data (email, username,
avatar), gameplay data, device identifiers for push, crash data (Sentry,
without email), and product analytics only after in-app consent (PostHog).
The privacy policy URL is `https://smarter.poker/privacy` once the World Hub
serves it as a page (phase 3b); today `/privacy` redirects to `/terms`, whose
privacy tab is client-rendered and not what a store crawler reads.

## Listing copy and review notes

`docs/APP-STORE-LISTING.md` has the store listing (name, subtitle, description,
keywords, content-rating and data-safety answers, the screenshot list, and
the reviewer notes with Dan's chips sentence) written once for both stores.

## Review notes (phase 7)

Give the reviewer a demo account (the service identity is NOT for this - make
a review account) and, in the notes, Dan's sentence about chips above, plus:
sign-in is email + password; purchases are diamonds (consumable) and VIP
(subscription) through the store; account deletion is in Settings; the age
gate asks a date of birth and refuses under 18. Budget two rounds.

## Where things stand

See the task list in the session that built each phase, and the changelogs
above. Anything that reads "Dan's" in a changelog is in the table at the top
of this file.
