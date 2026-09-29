# 2026-09-29 - The age gate had never shown to anyone

Found on the first on-device compliance walkthrough (Android emulator, a fresh
account created with the repo's own reserved `ca-customization-cert-` /
`@example.invalid` fixture convention). The account had no birthday on file.
After sign-in and terms acceptance, the app's age gate - audit tier 0, the
item that stands between a simulated-gambling app and an age-rating rejection

- should have blocked it. It did not appear.

## Why

`AgeGate.tsx` decided by reading two columns of the player's own profile:

    supabase.from('profiles').select('birthday, age_verified')

`age_verified` is one of the columns the profile-privacy lockdown revoked from
`authenticated`, alongside `email`, `phone`, every `kyc_*` and `jurisdiction_*`
column and `over_18_attested_at`. PostgREST refuses a whole select when any one
column is denied. Measured from the app's own session on the device:

    select=birthday                 -> 200
    select=age_verified             -> 403 42501 permission denied
    select=birthday,age_verified    -> 403 42501 permission denied

So the read failed for every player, the gate landed in its `'unknown'`
branch, and `'unknown'` rendered nothing. **1,290 of 1,293 profiles have no
date of birth on file, and not one of them was ever asked.** The unit tests
were green throughout: they pinned the component's source, not the database's
grants.

## The fix, and why it is two changes

1. **The gate asks the server.** `fn_my_age_gate_status()` (migration
   `20260929024148`, applied to production 2026-09-29) is `SECURITY DEFINER`,
   reads `auth.uid()`'s own row only, and returns `{ ok, verified }` - never
   the date. `verified` keeps the original meaning exactly: a birthday on file
   or `age_verified` set. (0 profiles have `age_verified` without a birthday,
   so the two readings agree for every player today.) Executable by
   `authenticated` only; verified on the device: the player gets
   `{"ok": true, "verified": false}`, an anonymous caller gets 401. No column
   grant can break the gate again.

2. **The gate fails CLOSED.** It originally failed open by design - "a blip
   must not lock the whole app". This bug is the counter-argument: when the
   gate broke _completely_, failing open made the breakage silent, so nobody
   noticed. Now an unanswerable status gets one quiet retry (so a request
   racing the session refresh at launch is not an outage), and then SHOWS the
   gate. That is safe: for a player who is already verified,
   `fn_set_my_birthday` returns `already_set` and the modal lets them
   straight through. The worst a real blip costs a verified adult is one
   question; a broken status now fails loudly.

## Two more things the device showed, fixed here

3. **An under-18 answer is now actually explained.** The refusal message
   lived inside the gate's modal, and the gate renders nothing for a
   signed-out player or on `/auth`. So the sign-out that follows a refusal
   unmounted the message almost at once. Measured on the emulator before the
   fix: refusal visible at +150ms, gone by +600ms, the player on the sign-in
   screen with no explanation. The refusal is now state in the gate itself,
   above the signed-in checks, raised BEFORE the sign-out, and stays until the
   player closes it. Measured after: still on screen at +4s on `/auth`;
   Close leaves them on the sign-in form. No date of birth is sent anywhere on
   this path (the only network calls are the sign-out's).

4. **The date field fills the card.** The Android WebView gives a date input
   an intrinsic width that beat the column's stretch, so the field sat at half
   the card. It is `width: 100%` now, with a 48px touch height.

Full cycle verified on the device with a fresh account: terms, then the gate;
an under-18 answer refused and explained; sign in again, the gate again; an
adult date written once through `fn_set_my_birthday` (`birthday` and
`age_verified` set, checked in SQL) and the gate gone on every later launch.

## Tests

`tests/components/AgeGate.failsClosed.test.tsx` renders the real component. Its
profile-table mock returns exactly what production returned (the 42501
refusal), so against the OLD gate the tests fail for the real reason rather
than a mock crash: "fails closed" waits its full four seconds and the gate
never appears - the production bug, reproduced - and "shows for a player with
no date of birth" fails the same way. Against the new gate all seven pass,
including: it calls `fn_my_age_gate_status` and never touches the profile
table; a single blip is retried rather than treated as an outage; a malformed
answer is not a yes; the legal pages, `/auth` and `/help` are never blocked.

`tests/components/AgeGate.refusal.test.tsx` drives the whole refusal sequence -
answer, sign-out, redirect to `/auth` - and pins that the refusal is still on
screen at the end and that `fn_set_my_birthday` is never called for a minor.
Against the old placement (refusal below the signed-in checks) the first test
fails with the refusal gone; with the fix all three pass.

## Found on the way, fixed outside this branch

Every worktree cloned from the main checkout since 2026-09-25 carried a stray
symlink `node_modules/node_modules -> <main>/node_modules` (an `ln -s` into
an existing directory). Node resolves scoped packages through it, so
`@testing-library/react` got the main checkout's React while components got
the worktree's: two Reacts, and every component test failing with
`Cannot read properties of null (reading 'useRef')`. Removed from the main
checkout and every worktree that had it (0 remain across 478); nothing else
was touched.

## Still to do, deliberately separate

`birthday` itself is readable by every signed-in player on every profile row
(a fresh account can filter all 1,293 rows by it), so any player can
binary-search any other player's exact date of birth. It should be revoked
from `authenticated` like `age_verified` was. That cannot be done first: the
World Hub profile editor reads its own birthday through the same column, and
revoking it would break profile editing on the live site. After this change
the app no longer depends on the column; the World Hub editor moves to an
own-row function next, and then the revoke. `birth_year` is deliberately
public (the World Hub profile page shows "Born In <year>") and is left alone.
