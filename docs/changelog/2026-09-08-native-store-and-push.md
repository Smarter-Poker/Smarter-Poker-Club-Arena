# 2026-09-08 - The store sheet and the device token (store readiness, phases 3c and 4b)

The client halves of two audit items whose server halves already merged:

- Tier 0, "Replace external Stripe Checkout with StoreKit and Play Billing".
  The database and webhook side is `docs/changelog/2026-09-08-in-app-purchases.md`
  (Club Arena migration `20260908000009_...`, World Hub `pages/api/store/webhooks/revenuecat.js`).
  This branch puts the purchase sheet in front of a player in the app.
- Tier 1, "Build the native push transport from scratch". The World Hub side
  (FCM HTTP v1 in `src/lib/push/fcm.js`, `/api/push/subscribe` accepting
  `transport: 'fcm'`, `push_subscriptions.transport`) merged as World Hub
  PR #1568. This branch enrols the app's device token.

Both live behind `isNativePlatform()` at runtime and under `src/lib/native/`
at build time. The web bundle does not change behaviour; the law test
`tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts` is green and
every Capacitor import in the new code is dynamic.

## Purchases (`src/lib/native/purchases.ts`, `marketplaceShared.ts`, `MembershipTab.tsx`)

`startCheckout()` is the one function every marketplace tab calls to pay with
a card. Its first branch is now the store: inside the app it maps the same
`items` it would have sent Stripe onto a store product id
(`nativePurchaseRequestFor`: `vip-monthly` / `vip-yearly` (and the retired
`vip-annual` spelling) / a diamond `packageId`; lifetime is not a store
product and is refused with copy that says so), opens RevenueCat's purchase
sheet for that product, and on completion sends the page to the same
`?purchase=success` return it already handles for Stripe. The page polls the
wallet for the credit, which arrives through the webhook and
`fn_iap_settle_event` - money moves in exactly one place, the same place
Stripe's does.

`@revenuecat/purchases-capacitor@13.5.0` is configured once per signed-in
user with the Supabase user id as the RevenueCat app user id (the webhook
keys on it). The SDK keys are `VITE_REVENUECAT_IOS_KEY` /
`VITE_REVENUECAT_ANDROID_KEY`, which are RevenueCat's PUBLIC keys and are
designed to ship in the binary; unset, the button says "Purchases Are Not Set
Up On This Build Yet." rather than failing silently (10.84: an agent reads
where a credential lives, never sets one - these are Dan's to create with the
RevenueCat account).

Apple 3.1.2 needs two things a web page never did, both native-only in
`MembershipTab.tsx`: a **Restore Purchases** button (`restoreNativePurchases`)
and **Manage Subscription** going to the store's own management screen
(`openNativeSubscriptionManagement`, via the in-app browser). The web keeps
its Stripe copy and its `/hub/diamond-store?tab=vip` link byte for byte.

## Push (`src/lib/native/push.ts`, `pushClient.ts`, `nativeShell.ts`, `capacitor.config.ts`)

Inside the webview there is no Web Push: no push service, no root service
worker, no VAPID. The OS hands the app a device token instead, and
`enableNativePush()` posts it to the SAME `/api/push/subscribe` a browser
subscription uses, as `{ transport: 'fcm', platform, endpoint: <token>,
deviceId, replacesEndpoint }`. One row shape, one dispatcher, one set of
per-type preferences and `mute_all`. `deviceId` and the Bearer header are
the browser path's own (`pushDeviceId` / `pushAuthHeaders`, now exported from
`pushClient.ts`), so the phone is one device to the server whichever way it
enrolled.

`pushClient.ts` keeps its public surface: `isWebPushSupported()` answers
"can this device receive our notifications", which in the app is yes;
`isIosStandalonePwa()` is true (the app IS the installed app, so no "add to
Home Screen" copy); `notificationPermission()` reads a cached native state
the shell primes at boot and every enable/disable refreshes; and
`enablePush` / `disablePush` / `hasLocalSubscription` branch to the native
transport before touching a service worker. Every caller - the settings
toggle, the first-run prompt, the enable banner, the boot-time repair loop,
Daily Challenges - works unchanged in the app. The opt-out marker keeps its
meaning: off in the app is off.

The shell attaches the plugin listeners at boot (`wirePush`) so a tap on the
notification that cold-started the app is still routed. Tap routing is the
deep-link handler: a `data.url` under `/hub/club-arena/` opens in the app,
any other Hub page opens in the in-app browser (the same rule every Hub link
follows on native). `presentationOptions: ['badge','sound','alert']` so a
foreground push is shown rather than swallowed on iOS.

## The Hub tab and sign-up

`openHubTab` in `MultiTablePage.tsx` declines on native. The webview's origin
is the app, not smarter.poker, so a `HubFrame` there would be cross-origin:
its same-origin listeners would throw and the Hub session would not be in
the frame. The header's existing fallback (`leaveForHub`) opens the page in
the in-app browser over the running tables, which is what the "+" tab was for.

`AuthPage.tsx` asks for a date of birth at sign-up in the app (Apple 1.1.4
and Play's simulated-gambling policy want the 18+ check before the account
exists). Under 18 never reaches `signUp()` and nothing about a minor is sent
anywhere; an adult's date is written through `fn_set_my_birthday`, the same
RPC the age gate uses, when a session comes back (email confirmation on: the
gate asks once on first sign-in instead). The age arithmetic moved to
`src/lib/age.ts` so the sign-up form can share it without importing the
gate's component and stylesheet; `AgeGate.tsx` re-exports it. The web
sign-up form is unchanged (`IS_NATIVE_BUILD` is compile-time).

`installHubFetchShim()` runs first in `boot()` on native: a relative
`fetch('/api/...')` from `capacitor://localhost` has no API behind it, so the
shim rewrites those to `https://smarter.poker` and leaves everything else
alone. Every existing `/api/` caller (push, store, VIP status, catalog) works
in the app without being touched.

## Verified

- `npx tsc --noEmit` clean.
- `tests/unit/nativeStoreAndPush.test.ts` (12 tests, behavioural where jsdom
  allows: the pushClient branches with a pretend bridge and a mocked native
  transport, tap routing against the real `parseAppUrl`, the product mapping)
  plus `nativeCompliance`, `nativeFeel`, `appBase`, `deepLinks`,
  `iapProducts` and the web-bundle law.
- The store sheet and the token itself need a phone with a store account
  and a Firebase project; neither exists yet (Dan, Phase 0: "nothing
  exists"). `docs/APP-STORE-RUNBOOK.md` lists what to create and where each
  key goes.

## Not done here, on purpose

- RevenueCat, App Store Connect, Play Console and Firebase accounts and
  keys: Dan's (10.84).
- Lifetime VIP as a one-time store product: not sold on the web either
  (`checkoutPlan` is null on it); diamonds remain the way to buy it.
