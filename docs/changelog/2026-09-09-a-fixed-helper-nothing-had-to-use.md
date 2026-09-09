# 2026-09-09 - A fixed helper that nothing had to use (store readiness, re-audit)

Dan asked for the whole readiness audit to be re-checked against `origin/main`
rather than against memory, on the claim that only human tasks were left. Three
things were still ours. All three fail the same way: silently, in the app only,
with no error anyone would see.

## Ten screens never used the download fix

Phase 5 fixed `src/utils/downloadCsv.ts` so a file handed to the user inside
the app goes to the system share sheet, because a webview does not honour the
`download` attribute and produces nothing at all. That fix was correct. It was
also, on its own, worth very little: ten screens had rolled their own
`<a download>` and never went near the helper.

    src/lib/export.ts                          src/pages/AdminDashboardPage.tsx
    src/components/admin/StatsExport.tsx       src/pages/UnionDashboardPage.tsx
    src/components/table/HandNotation.tsx      src/pages/HandHistoryPage.tsx
    src/components/table/HandHistoryPanel.tsx  src/pages/admin/AnalyticsDashboard.tsx
    src/components/wallet/WalletCashierModal.tsx
    src/pages/club/ClubDashboard.tsx

Among them the club bank ledger, the promo wallet ledger and the admin audit
log - exports used to settle money. Two of them (`WalletCashierModal`,
`ClubDashboard`) defined a LOCAL function also called `downloadCsv`, which is
why a grep for the helper's name looked clean while the app downloaded nothing.

`downloadBlob(filename, blob)` is now the one implementation and `downloadCsv`
is a thin wrapper over it that adds the Excel BOM. All ten call sites go
through it; the two shadowing locals are renamed (`downloadLedgerCsv`,
`downloadClubCsv`) so the name cannot lie again. `src/lib/export.ts` keeps its
`(blob, filename)` argument order for its callers and delegates.

## Seven asset addresses in the Daily Bonus sheet

The tier-1 asset sweep ran before the Daily Bonus feature existed, and that
sheet hardcodes `/hub/club-arena/assets/...` in seven `url()` rules - the panel
art, the nav shell, both buttons. `dist-native/` has no `hub/` directory, so
every one of them drew nothing in the app.

Vite rewrites a root-relative `/assets/...` with the build's base, so dropping
the prefix is correct in both builds from one source line. Verified rather than
assumed: the web chunk is byte-identical (same content hash,
`DailyBonusSheet-D4QlYyrt-v6.css`, before and after), and in `dist-native` all
seven now resolve to files that exist.

## The tab strip lost swipes that left it

`useSwipeTabs` recorded the start point on `pointerdown` and decided on
`pointerup`, with no capture. A flick that lifts outside the strip - easy,
because it is narrow - never delivered its `pointerup` there and the tab change
was dropped with no feedback. It captures the pointer now, and releases on
cancel.

## The law, so this is the last time

The pattern in all three is the same: something was fixed centrally and nothing
required anyone to use the fixed thing.
`tests/every-file-the-user-gets-goes-through-one-door.law.test.ts` now requires
it. A file may set a download attribute only if it also branches on
`isNativePlatform()` to `nativeShareBlob` first, and no `url(`, `src=` or
`href=` in `src/` may name `/hub/club-arena/`. Both scans strip comments, so
prose about the bug is not itself a violation.

The law was proven to bite before it was trusted: reintroducing one download
and one asset path made it fail, naming
`src/pages/UnionDashboardPage.tsx` and
`src/components/daily-bonus/DailyBonusSheet.css:86`. The door itself is tested
behaviourally rather than by text - it is under the source-grep ratchet, which
is back at 5/5 - by exercising both paths against a pretend bridge and
asserting the app path never touches the DOM.

## The rest of the audit, re-checked and already true

Tier 0: chip wording, store billing (no `location.assign` to Stripe left, and
`DiamondService`'s no-payment dev fallback is gone), conditional base and
basename, login in-app, session on native storage (the SSO migration and its
`window.location.reload` are behind `!IS_NATIVE_BUILD`), age gate, account
deletion via `DELETE /api/auth/delete-account`, terms wired (`TermsGate` deleted
as dead), consent-gated analytics with no email to Sentry, email-and-password
only so 4.8 does not apply, icon and splash present as placeholder art.

Tier 1: native push, deep links, share builders, zero `window.open` outside
`openExternal`, absolute `/api` origin with CORS, `/privacy` server-rendered.
The two `index.html` `/src/*.css` preloads the audit called dead are NOT dead -
they are the only way `globals.css` and `design-tokens.css` reach the bundle,
and deleting them silently dropped 18 kB of rules on 2026-09-07. The comment
above them now says so.

Tier 2: haptics, keep-awake, overscroll and touch-callout (both under
`html.ca-native`, so the web keeps its rubber-band and long-press menus), safe
areas on Modal and BottomSheet, native orientation lock via the manifest and
plist rather than CSS, Preferences-backed session.

Tier 3: both AudioContexts resumed on foreground, sw-bus decided, source maps
off native, fonts self-hosted (`dist-native/index.html` has no googleapis),
self-heal neutralised, scratch files gone. `three` is no longer imported by
anything - the WebGL profiling item is moot - though it remains an unused
dependency. The `-v6` suffix stays: it is the web CDN's cache key.

## Verified

`tsc --noEmit` clean. Full suite green except eight law tests that fail only
under whole-suite parallel load and pass in isolation, none of them touching
these files. Web production build passes the entry-chunk gate. Both builds
inspected for the asset paths above.
