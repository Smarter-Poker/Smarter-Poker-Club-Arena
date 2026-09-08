# 2026-09-08 - What a reviewer reads, and what the app collects (store readiness, phase 3b)

Phase 3 of the Capacitor Readiness Audit, the parts that do not touch the
files phase 2 (auth) is changing: the chip wording, the age gate, consent for
analytics, Sentry without the email, the privacy policy, and the one client
path that could credit diamonds with no payment. The store-billing client
(the purchase sheet replacing Stripe Checkout in the app, and the "+" hub tab
on native) is phase 3c, after phase 2 merges.

## Chips, in Dan's words (ruling 2026-09-07)

"Chips are club play credits. Smarter.Poker does not sell, redeem or pay out
chips and assigns them no monetary value; any arrangement between a member and
their club's agent is private and off-platform." That sentence now appears,
title-cased, in the three places a reader meets the question: the welcome
disclaimer (`ClubArenaWelcomeModal`), the Terms (`TermsOfServicePage`, section
retitled "Chips Are Club Play Credits") and the acceptance modal
(`TOSAcceptanceModal` section 4). The line "cannot be exchanged for real money
or prizes" is gone from all three, as ruled, and diamonds are described as a
virtual currency Smarter.Poker sells for use inside the platform only.

Terms acceptance itself (audit tier 0 "wire terms acceptance for real") was
already done on main by #3007's successor on 2026-09-02: `TOSGuard` blocks on
`not_accepted` and posts to `/api/club-arena/accept-tos`. Not re-done.

## The age gate

The World Hub's signup already asks a full date of birth and refuses under
18; the gaps were accounts that predate `profiles.birthday` (1,189 of 1,192)
and the app's own in-app signup. `fn_set_my_birthday(date)` (migration
`20260908004420`, applied to production) is the one client path that writes a
date of birth: the caller's own (`auth.uid()`), once (a different date later
is refused; the same date is a no-op), refused under 18 with NOTHING written -
a minor's date of birth is not something to keep - and it sets `age_verified`.
Probed as an `authenticated` caller in a rolled-back transaction: 17y11m ->
`under_18`, nothing written; 1990-05-04 -> written, `age_verified` true; a
different date -> `already_set`; the same date -> no-op success.

`AgeGate` (`src/components/legal/AgeGate.tsx`) renders as a full-screen
overlay beside the route tree inside `TOSGuard` (a wrapper would re-indent
1,500 lines of App.tsx and every text pin on them): a signed-in player with no birthday is asked once, with a native
date picker; under 18 is refused on the client before anything is sent, and
the account is signed out with a plain message. `/legal`, `/auth` and `/help`
stay reachable; a failed read renders the app and re-checks on navigation, as
`TOSGuard` does. NATIVE ONLY, deliberately: asking every existing web player
on their next visit is a product change on the web, which Dan asked not to
change, and the stores review the app. `AGE_GATE_ON_WEB = false` is the one
line that turns it on for the web; that is Dan's.

## Analytics: opt-in in the app, unchanged on the web

`src/lib/consent.ts` holds one answer per device. Inside the app PostHog
loads and captures only after the player says yes (`ConsentPrompt`, a small
sheet shown once after sign-in, never a wall; the answer can be changed under
Settings > Account Data with a "Share Usage Analytics" switch). On the web
`analyticsAllowed()` is true and nothing changes.

Sentry keeps reporting errors on every target (a table that stops dealing has
to be seen), with two changes: the email address is no longer attached to the
user context anywhere (id and username are enough to find a player's events,
and an address on every error is the one thing the privacy labels would have
to call "contact info linked to you"), and in the app there is no session
replay integration and both replay sample rates are 0.

## The privacy policy names its services

`PrivacyPolicyPage` gains "Third-Party Services We Use": Supabase, Sentry
(what an error carries, and that it does not carry the email), PostHog (opt-in
in the app), the App Store and Google Play (purchase records, never payment
details; Stripe on the web), Firebase Cloud Messaging (a device token). The
server-rendered copy at `https://smarter.poker/privacy` for the store
crawlers is the World Hub change that follows.

## No credit without a payment

`DiamondService.purchaseDiamonds()` fell through to `fn_add_diamonds`, a
"development fallback" that credited a package with no payment. Checked
against production: the function is executable by `service_role` only, so a
browser could never have reached it, and the method has no caller. It is
removed anyway - a credit path that exists in client code is a credit path
somebody calls one day - and the method now refuses without a payment method.

## Also in this branch

- `SettingsPage` "Export Data" goes to the share sheet in the app (a webview
  honours no `<a download>`); `src/lib/native/share.ts` is added here
  byte-identical to phase 5's copy so the two branches merge clean.

Pinned by `tests/unit/nativeCompliance.test.ts` and the updated
`tests/unit/DiamondService.test.ts`.

## Entry chunk (CI's "Entry Chunk Is A Reviewed List" gate)

`src/lib/consent.ts` enters first paint (+1 module, +0 kB gz): `analytics.ts`
is already in the entry and now asks it before loading PostHog. `AgeGate`,
`ConsentPrompt` and their stylesheets do NOT: both are behind a dynamic
import gated on the compile-time constant, so the web bundle carries neither
(verified: the entry chunk names no AgeGate). Baseline updated in this commit.
