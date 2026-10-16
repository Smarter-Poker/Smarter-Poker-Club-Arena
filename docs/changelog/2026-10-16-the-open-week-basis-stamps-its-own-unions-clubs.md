# The Open-Week Basis Stamps Its Own Union's Clubs (2026-10-16)

Migration `20261016104931_the_open_week_basis_stamps_its_own_unions_clubs.sql` (held draft, owner installs).

## What Fired

`fn_union_rake_basis_refresh` (financial alert, kind `out_of_time`, Midway Union) at 02:35 UTC. Filed once while open; the union-integrity sweep then hit its 300 second timeout again at 07:35, 08:35 and 09:35, and Midway Union's open-week `union_rake_basis_snapshot` was last written 2026-10-15 17:35.

## Cause, Read From Rows

`fn_union_rake_basis_windowed` reuses each closed two-hour window while its input stamp is unchanged. The stamp included `fn_accounting_clubs_scope_digest()`, an md5 over every club on the platform. Certification fixtures create and remove clubs all day (148 club opening grants in the 24 hours to 10:50), so the digest stored at 10:36 had moved by 10:50 and again by 10:52 while Midway Union's own four clubs did not change. Every hour all 44 closed windows were recomputed (373 seconds at 10:36) and the refresh could not finish.

Not caused by an r5 install.

## The Money

Nothing to settle. The snapshot is a reporting read; the sweep's money controls committed every hour.

## The Fix

The window stamp digests this union's clubs only (its own row and every club whose `union_id` is the union), same columns, same order. A club joining or leaving the union still moves the stamp.

Regression: `scripts/ci/test-the-open-week-basis-stamps-its-own-unions-clubs.py`, run by `.github/workflows/the-open-week-basis-stamps-its-own-unions-clubs.yml` (11 checks, native PostgreSQL).
