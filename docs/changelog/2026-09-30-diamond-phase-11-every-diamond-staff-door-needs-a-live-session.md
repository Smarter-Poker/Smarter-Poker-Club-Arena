# An Old Client Lands Somewhere True: Every Diamond Staff Door Needs A Live Session

2026-09-30. Diamond Phase 11, line 7: "Test old bookmarks, expired/revoked
sessions, stale storage, service workers and mobile rotation." The matrix and
every result are in
[docs/evidence/diamond-phase-11/stale-clients.md](../evidence/diamond-phase-11/stale-clients.md).
The matrix found four defects; this change fixes all four. One migration,
`20260930131500`, and four small client changes. Neither Diamond switch is
touched, and no economics, price or grant.

---

## 1. Ten Diamond Staff Desk doors obeyed a revoked session

A session revoked on another device keeps an access token that verifies until
it expires, because PostgREST checks the signature and never the session row.
Only a door that asks `public.fn_caller_session_is_live()` can refuse it. Of the
Staff Desk's seventeen doors, five already did (close, edit, cancel, remove,
seat-first board: `diamond_staff_session_required`, SQLSTATE 28000), and so do
the player money doors. Ten writers asked only `fn_is_platform_admin()`, which
reads `profiles.role` and never the session: opening a Diamond cash table, its
straddle, run-it-twice and bomb-pot settings, proposing, approving, rejecting
and **settling** a Diamond correction (settling moves Diamonds through the
register), and reviewing or closing incidents.

A rolled-back production rehearsal proved it before the fix: with no migration,
a revoked session and a token with no session claim both reached each of the
ten doors' next check (20 of 41 checks failed, exactly those). Migration
`20260930131500_every_diamond_staff_door_needs_a_live_session` pins each door to
its live md5 and redefines it from that exact text plus one check, directly
after the staff check, in the door's own refusal style: the table doors raise
`diamond_staff_session_required` (28000) like their siblings, the adjustment
doors answer it as `refused_reason`, the incident doors answer the
`authentication_required` code they already give a missing account. Rehearsed
(REHEARSAL OK, 41 checks: every door refuses both dead shapes by name, a live
session passes to each door's next check, nothing written), applied once by
`apply.sh` (APPLIED AND RECORDED), every `@live-proof` true.
`tests/every-diamond-staff-door-needs-a-live-session.law.test.ts` pins the
migration and the law: every door the desk's service files call that writes
must ask for a live session in its latest definition. The desk's three reads
and tournament creation were closed minutes later by line 1's migration
`20260930120000` (a forged request is refused), built on this one, so all
seventeen desk doors now refuse a revoked session.

## 2. The money screens told a dead session to retry

At a buy-in (`atomic_table_buyin`: `SESSION_REVOKED`, 28000) the table said
"Buy-In Not Yet Confirmed. Retrying Uses The Same Request."; in Send Diamonds
(`send_wallet_diamond_transfer`: 42501 `authentication_required`) the form said
"Transfer Not Yet Confirmed. Retry This Transfer...". Both kept the saved
request, which is right (a retry reuses its key and can never be a second
purchase or transfer), and then asked for the one thing that cannot work until
the player signs in. `src/lib/deadSessionRefusal.ts` recognises exactly those
refusals (SQLSTATE 28000, or 42501 with the transfer door's name) and hands the
page to `lib/sessionRevoked`, which asks GoTrue first and only on a definite
answer prompts and sends the player to sign in and back. The saved request is
untouched; neither journal is purged by a sign-out. The Staff Desk now reads
`diamond_staff_session_required` as "Your Session Has Ended. Sign In Again."

## 3. A Diamond figure with no owner was painted as the player's

`wallet-store` persisted `diamonds` without `_diamondsUserId` or
`_diamondsAt`. After a sign-out the app never saw (the World Hub signing out
while this app was closed), the next account on the device booted painting the
previous account's Diamonds as its own, and kept them if its first read failed.
The owner and time are now persisted; a figure an older build saved (store
version 0) is discarded, not shown; a figure another account owns is cleared
before the read, so it is never painted, not even after a failed read. The
same account still keeps its own last figure through a failed read (the
2026-08-24 rule). GlobalHeader's realtime write stamps the owner too.

## 4. A pinned-clubs value of the wrong shape took the Poker Arena home down

HomePage handed `JSON.parse` of `club_arena_pinned_clubs` straight to
`.includes` in its sorts, so `null`, `{}` or a number (storage outlives every
build and is shared with the World Hub) threw for any player with two joined
clubs. `savedPinnedClubIds` keeps an array of strings and discards anything
else.

## Tests

- `tests/every-diamond-staff-door-needs-a-live-session.law.test.ts` (19).
- `tests/unit/aDeadSessionIsASignInNotARetry.test.ts` (17) and the updated
  `tests/components/DiamondWalletTransfer.test.tsx` (7).
- `tests/unit/staleStorageIsReadSafelyOrDiscarded.test.ts` (24).
- `tests/e2e/an-old-bookmark-lands-somewhere-true.spec.ts`: every URL the
  Diamond Arena has had, against production signed out (17 passed); it runs in
  the daily `live-e2e` job.
- `tests/stale-client/`: a local, production-shaped origin
  (`deploy-server.mjs`) serving two real builds, and two suites run with
  `playwright.stale-client.config.ts`: an old service worker and its cached
  bundle across a deploy, and a signed-in Diamond player (answered entirely in
  the browser) through rotation, session expiry, refusal, sign-out elsewhere
  and revocation, and stale storage.

Bundle: initial load unchanged (314/320 kB gz), whole app 2874 -> 2875/2880 kB
gz; the entry-chunk gate reports nothing new before first paint.
