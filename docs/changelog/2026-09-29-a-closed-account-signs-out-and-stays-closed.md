# 2026-09-29 - A closed account signs out, and stays closed

Closing an account from Settings on the Android emulator worked on the server

- the profile was scrubbed, the Auth user soft-deleted, the erasure record
  completed - and then the app did not sign out. It showed "Your Account Has Been
  Closed. Signing You Out.", then "Your Session Expired. Please Sign In Again.",
  then the closed account's scrubbed profile in the Complete Your Profile card,
  with the daily bonus behind it.

## Why the app stayed signed in

Soft-deleting the Auth user removes its sessions. The app's sign-out then asks
the server to end the session and gets 403 `session_not_found` (auth log,
05:34:56 UTC). `@supabase/auth-js` 2.90 - this app's version - turns that into
`AuthSessionMissingError` and returns it WITHOUT removing the local session;
later versions ignore that error and finish the sign-out. So the session stayed
in storage and in the native session mirror, with an access token good for
6.9 more days, and every screen carried on as the closed account. The same
happens after any sign-out that follows the server ending the session: sign out
everywhere, a password change, a revoked login.

`IdentityDNA.logout()` now finishes such a sign-out instead of reporting it:
`src/lib/forgetEndedSession.ts` removes the local session the way the library
does once the server agrees, so SIGNED_OUT reaches IdentityDNA's cleanup, the
native session mirror and AuthGuard's redirect.
`tests/unit/aSessionTheServerEndedIsSignedOut.test.ts` runs the real library
against a server answering the way GoTrue did: its first case pins the library
behaviour (when an upgrade fixes it, that case fails and the workaround can
go), the rest hold `logout()` to it.

## Why the database needed a guard too

Closing an account does not end the access tokens already issued: PostgREST
checks a token's signature and expiry, not its session. Measured on production
in a rolled-back transaction, the closed walkthrough account's own token could
still set its display name - so any device still signed in to a closed account
could write a name and a picture straight back into the scrubbed profile.

Migration `20260929054441_a_closed_account_cannot_rewrite_itself` adds a BEFORE
UPDATE trigger on `profiles`, for rows whose status is `deleted`, that refuses
a change made with that account's own token (`auth.uid()` is the row), directly
or through a definer function. The service role, jobs and staff are unaffected.
Measured before applying, rolled back: the own-token write succeeded before the
trigger and was refused after it (42501); the service role, a database job and
an open profile's own token all still updated. Applied 05:44 UTC; the live
body's md5 matches the file's.

## Left for a decision

The tokens themselves: this project issues access tokens that live about seven
days. The platform's default is one hour. A shorter lifetime bounds how long
any ended session - a closed account, a password change, a stolen device -
keeps working against the database. It is an Auth setting, not a code change.
