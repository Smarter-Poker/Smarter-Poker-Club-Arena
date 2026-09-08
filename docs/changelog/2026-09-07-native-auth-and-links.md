# 2026-09-07 - Auth, session and links inside the app (store readiness, phase 2)

Phase 2 of the Capacitor Readiness Audit. Phase 1 (`2026-09-07-capacitor-shell.md`)
made the bundle boot at the native root; this makes it usable there. The audit's
exit criterion, verbatim: "sign up, sign out, sign in, reset a password and open
an invite link, all without leaving the app." Every change is gated on the
native target and the web behaves exactly as it did.

## Tier 0: bring login back inside the app

Every unauthenticated hit on ~40 protected routes ran
`window.location.href = '/auth/login?...'`, a World Hub page that is not in the
bundle. `src/lib/signIn.ts` now decides, once, for every caller:

- web: `/auth/login?[authError=x&]redirect=<web path>` - byte-identical to
  what AuthGuard, HamburgerMenu, DailyChallengesPage and
  `sessionRevoked.loginRedirectUrl()` each built by hand;
- native: `/auth?[authError=x&]redirect=<in-app path>`, the local AuthPage.

AuthGuard routes there with `<Navigate>` on native (no reload, tables kept).
AuthPage no longer bounces an unauthenticated visitor away on native, honours
`redirect=` after sign-in (through `safeInAppRedirect()`, which refuses full
URLs, protocol-relative paths and the auth page itself), explains
`authError=no_session` in words, and has the form the audit found missing:
"choose a new password" (`mode=update`), opened by a `PASSWORD_RECOVERY` event
or by a recovery deep link, submitting `supabase.auth.updateUser()`.

Email links (`emailRedirectTo`, password `redirectTo`) go through
`src/lib/authReturnUrl.ts`: always an https URL on the public origin, because
that is what Supabase's allow-list permits and what an email can open. On the
web it is the current origin (a preview keeps testers on itself); in the app it
is smarter.poker, which becomes a universal link into the app the day
`apple-app-site-association` / `assetlinks.json` are served (phase 6).

## Tier 0: the session survives a cold start

The audit's reading was that the shared `smarter-poker-auth` key cannot exist
in a webview. It can: the webview's localStorage persists across launches, and
once the in-app AuthPage signs a player in, the three synchronous readers
(`supabase.ts`, `authUtils.ts`, `cachedIdentity.ts`) work unchanged. What is
missing is a Hub to sign in through - fixed above - and resilience against the
webview's storage being website data that iOS may evict. So the session is
mirrored, write-through, into the app's own store (`@capacitor/preferences`,
`src/lib/native/sessionMirror.ts`) on every auth event, and restored from there
at boot BEFORE `initIdentityDNA()` runs (`main.tsx` `boot()`; on the web the
body has no `await` and runs synchronously, so the boot order is unchanged).
localStorage stays the live store; no reader changed; `flowType: 'implicit'`
stays because email + password does not need PKCE and the native OAuth
providers are not shipping (Dan's ruling). The old-key migration block in
`supabase.ts`, with its module-scope `window.location.reload()`, is skipped on
native: no app player ever had the old key.

## Tier 1: deep links and a custom scheme

`clubarena://clubs/abc` opens the app with no store account needed
(`Info.plist` `CFBundleURLTypes`, `AndroidManifest.xml` intent filter).
`https://smarter.poker/hub/club-arena/...` is registered as an Android app
link (`autoVerify`) and will be an iOS universal link once the Associated
Domains entitlement has a Team ID. Both reduce to one in-app path in
`src/lib/native/deepLinks.ts` (`parseAppUrl`, pure and tested; a link on any
other host is not ours) and route in place through `src/lib/routerBridge.ts`,
which holds the router's `navigate()` (registered by `<RouterBridge/>` in App)
so a plugin listener can route without reloading the app. A recovery or
confirmation link that carries tokens in its hash never had a page load for
`detectSessionInUrl` to see, so the tokens are handed to the SDK explicitly
(`setSession` / `exchangeCodeForSession`) and a recovery opens the new-password
form. The shell (`nativeShell.ts`) listens for `appUrlOpen` and also asks for
the launch URL, since a cold start can fire before the listener exists.

## Tier 1: share links, invites and the six window.open calls

Fourteen builders used `window.location.origin`, which is
`capacitor://localhost` in the app. They use `publicOrigin()` (current origin
on the web, smarter.poker on native): TournamentRankingCard, PlayerInviteModal,
ReferralDashboard, handHistoryLive, PlayerWalletPage, ClubHomePage, TablePage,
TournamentDetails, ClubSettingsPage, PromotionsPage, PlayerStatusService.

Leaving the bundle goes through `src/lib/openExternal.ts`: `leaveForHub()` is
`window.location.href` / `.replace` on the web and the in-app browser
(SFSafariViewController / Custom Tab, `src/lib/native/browser.ts`) on native,
so the player comes back with their tables still open; `openInBrowser()` is
`window.open` on the web and the same in-app browser on native. Sites:
NavigateToMessenger, GlobalHeader, NotificationDropdown, NotificationsPage (x2),
marketplaceShared (Stripe, until phase 3 replaces it), ShareHand, HubFrame,
MultiTablePage, AvatarService, HandHistoryPage. The hub-tab law's pin on
`window.open` in HubFrame moved to `openInBrowser` in this commit, as 10.6
requires when a mechanism is replaced.

`pushClient.isWebPushSupported()` is false on native: there is no push service
behind the webview and no root service worker. The banners stay hidden until
phase 4 adds the FCM/APNs path.

## Also

- iOS phones and Android are locked to portrait at the OS level (Dan
  2026-08-28: "lock it, portrait mode only"; the CSS prompt in PortraitLock
  stays for the web). iPad keeps rotation.

## Law

`tests/the-web-bundle-does-not-know-the-app-exists.law.test.ts` now also pins:
no `window.open` outside `openExternal.ts`; no literal `/auth/login` outside
`signIn.ts` / `sessionRevoked.ts`; AuthGuard's native `<Navigate>`; AuthPage's
native branch, return URLs and recovery listener; the scheme in both shells.
Unit tests: `tests/unit/signIn.test.ts`, `tests/unit/deepLinks.test.ts`.

## Still Dan's, for this phase to be complete on a device

- Supabase Auth > URL Configuration: add `capacitor://localhost` and
  `https://localhost` to the redirect allow-list (used only if a provider
  redirect is ever added; email links use smarter.poker, already allowed).
- `apple-app-site-association` (needs the Apple Team ID) and
  `assetlinks.json` (needs the release keystore's SHA-256), served from the
  World Hub at `/.well-known/` - phase 6, with the runbook.

## Known native gap carried to phase 5

The "+" hub tab (`HubFrame`) frames smarter.poker pages same-origin on the web.
In the app that frame is cross-origin, so its location reads and swipe
handlers cannot attach. Phase 5 opens hub pages in the in-app browser on
native instead of framing them.

## Entry chunk (CI's "Entry Chunk Is A Reviewed List" gate)

Four modules enter first paint, by design, +1 kB gz in total: `signIn.ts`
(AuthGuard wraps ~40 routes and must know where "sign in" is before the first
render), `openExternal.ts` (GlobalHeader is on every page), `routerBridge.ts`
and `RouterBridge.tsx` (a deep link that LAUNCHES the app has to be routable
the moment the router mounts). None of them imports anything heavy; the
Capacitor code behind them stays in `src/lib/native/`, loaded only on native.
Baseline updated in the same commit, as the gate asks.
