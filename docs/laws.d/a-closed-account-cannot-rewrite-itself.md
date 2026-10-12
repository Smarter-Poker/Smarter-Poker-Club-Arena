# tests/a-closed-account-cannot-rewrite-itself.law.test.ts

Closing an account from the Android emulator on 2026-09-29 left the app signed
in to the closed account, one tap from writing a name and a picture back into
the scrubbed profile. The app half was a sign-out bug in supabase-js 2.90,
fixed beside this; the database half is that closing an account removes its
sessions but not the access tokens already issued, PostgREST checks only a
token's signature and expiry, and this project's tokens live for days.
Measured on production in a rolled-back transaction: the closed account's own
token could still set its display name. So an update of a profile whose status
is 'deleted', made with that account's own token, is refused by a BEFORE UPDATE
trigger - whichever path it takes, a direct write or a definer function acting
for the caller - while the service role, the database's own jobs and staff
tools, whose auth.uid() is not the row, are unaffected. This law holds the
trigger to that single condition and to rows whose status is 'deleted'.
Its other half: `authenticated` holds UPDATE on profiles.status, so an open
profile's own session could mark itself 'deleted' and then not undo it - one
call locked a player out (measured). A second trigger refuses the owner's
token setting 'deleted' on a profile that is not closed; closing belongs to
fn_close_account, called with the service role. That trigger is its own,
never a DROP and recreate of the first: DROP TRIGGER takes an ACCESS
EXCLUSIVE lock on profiles, and it deadlocked against live traffic.
