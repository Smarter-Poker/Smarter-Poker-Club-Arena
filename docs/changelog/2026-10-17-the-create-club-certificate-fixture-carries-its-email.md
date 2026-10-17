# The Create Club certificate fixture carries its email

**2026-10-17.** `Club Create Certification` failed on every deploy from 08:27 UTC
(runs 39017429777 through 39024600837) with
`CERTIFICATION_RETIREMENT_PROFILE_REFUSED`.

## Cause, read from rows

Run 39017429777 created `ca-customization-cert-postdeploy-direct-1792225732288-m7rbj8`,
certified club creation (PASS), then failed its own cleanup. Its `profiles` row
has `email = NULL`; it is the only profile created in the last 30 hours without
one. `certify-club-create.mjs` upserts the fixture profile with `id`, `username`
and `display_name` only. When that upsert lands before the signup hook writes
the row, the row is created without an email and the hook's insert conflicts.
The guarded retirement door (`cleanup_reserved_certification_account`) proves a
certification identity by `profiles.email = auth.users.email`, so it refused the
fixture, and every later run refused it again in the residual sweep before it
could certify anything.

## Fix

- The fixture upsert carries `email`, so the row is correct whichever write wins.
- The residual sweep restores a missing profile email from the auth record
  (`.is('email', null)` only) before calling the guarded door, so the stranded
  fixture is retired by the next run through the same guarded path.

The door's identity check is unchanged. A rolled-back probe as `service_role`
updated exactly one row and the door's profile predicate then held.

`tests/unit/clubCreateCertificationContract.test.ts` pins both.
