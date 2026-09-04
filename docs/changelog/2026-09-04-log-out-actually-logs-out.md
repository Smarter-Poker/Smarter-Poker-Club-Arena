# Log Out actually logs out

2026-09-04. Dan, verbatim: "WHEN YOU CLICK THE HAMBURGER MENU, THEN CLICK
'LOG OUT' IT SILENTLY FAILS."

Three independent branches could swallow that click. The drawer's own e2e
spec never caught any of them because `tests/e2e/routes/hamburger-menu.spec.ts`
asserts Log Out is *visible* and never clicks it.

## 1. A failed signOut left the session in place, and the safety net restored it

`supabase.auth.signOut()` resolves with `{ error }` rather than throwing for
anything that is not 401/403/404 - offline, a 5xx, the GoTrue 429 the platform
hit on 2026-09-01. Verified in `node_modules/@supabase/auth-js`: on that path
`_signOut` returns BEFORE `_removeSession()`, so

- `smarter-poker-auth` survives in localStorage, and
- no `SIGNED_OUT` event is emitted, so `IdentityDNA`'s handler never runs and
  `clearUserCaches()` never fires. The previous account's cached clubs, hand
  history and lobby stay on the device.

`identityDNA.logout()` rethrows, `handleLogOut` caught it, cleared the Zustand
store and closed the drawer. `AuthGuard` then reacted to the empty store,
checked localStorage, found the surviving JWT, logged "Store cleared but
localStorage has valid session - re-hydrating instead of redirecting" and
deliberately did not redirect. The safety net signed the user back in.

Neither `handleLogOut` nor `identityDNA.logout()` ever touched that key, which
is the only evidence `AuthGuard` consults.

**Fix:** the key is removed in a `finally`, on every path, by the handler
itself. Nothing downstream is trusted to have done it.

## 2. The redirect was delegated to a component that is not always mounted

`AuthGuard` is applied per leaf route. `/legal`, `/legal/tos`,
`/legal/privacy`, `/legal/fair-gaming` and `/legal/promotions` are declared
without one - and all five are linked from this same drawer's Support & Legal
section (`src/config/clubArenaNavigation.ts`). The hamburger lives in
`AppLayout`, outside `AuthGuard`, so it renders there. Signing out from Terms
Of Service genuinely succeeded and nothing moved.

**Fix:** the handler issues `window.location.href` itself.

## 3. The breadcrumb nothing ever cleared

`club-arena-auth-breadcrumb` had exactly three references in the repo, all
inside `AuthGuard.tsx`: the constant, the write, the read. Nothing removed it.
So `wasRecentlyAuthenticated()` was true on every real logout, taking
`AuthGuard` down its "delaying redirect" branch - 800ms of visible nothing
after the drawer closed, with no spinner and the button still live. It also
cost a returning user two more 800ms retries on the loading screen for the
next 30 minutes.

**Fix:** the constant moved to `src/lib/authUtils.ts`, beside
`AUTH_STORAGE_KEY`, so the writer and the clearer share one definition - a
component should not import a component for a string. It is cleared on the
sign-out path and in `IdentityDNA`'s `SIGNED_OUT` branch, so a sign-out
triggered from anywhere else is covered too.

## Also

An in-flight latch. The button was never disabled and the `await` had no
timeout, so it was re-clickable throughout, firing a second network call and a
second redirect.

## Law

`tests/unit/logOutActuallyLogsOut.law.test.ts`, registered in `docs/LAWS.md`.
Seven cases. Verified 7/7 failing against `main` @ `ab689d6` and 7/7 passing
against this branch, so it is a real gate rather than a restatement.

## Not fixed here

Found in the same audit, none of it a logout bug:

- **Reset Tutorial is a dead control.** It clears `INTRO_SHOWN` and
  `TUTORIAL_COMPLETED` and toasts "Refresh the page to see the intro again."
  Neither key has a reader anywhere, and `App.tsx:285` hard-disables the intro
  (`useState(false)`, "DISABLED - intro video turned off"). Refreshing can
  never show an intro.
- **Change Avatar** does not call `onClose()` (its sibling Table Studio does,
  with a comment explaining why), never resets `showAvatarGallery` when the
  drawer closes - so the next open re-pops it and leaves `body.overflow`
  locked with no modal on screen - and is wrapped in `{user && ...}`, so with
  no session the button sets state and nothing appears.
- **The disputes attention badge is unreachable.** It renders only when
  `item.path.endsWith('/disputes')` and no item this drawer can produce does.
  The 20s count query still fires on every club-staff open.
- **Both route-connectivity guards share one hole.** `'*'` from the 404 route
  is in the declared set and is treated as a segment wildcard, so any dead
  single-segment link passes `hamburgerMenuLaw.test.ts` and
  `navigationSurfacesLaw.test.ts` alike. The two matchers are duplicated
  verbatim rather than shared, so fixing one leaves the other.
