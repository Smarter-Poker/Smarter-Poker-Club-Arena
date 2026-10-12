# A Satellite Target Is A UUID, Not Text

2026-10-03

## What was broken

`Club Create Certification` run **37094163115** died at:

```
42883  operator does not exist: text = uuid
```

`20261003021809_welcome_reset_complete_package_graph` (PR #5898, squash
`1f3d5f24d8`) installed the SATELLITE leg of the welcome-package graph into both
authorities as:

```sql
WHERE target.id=t.satellite_target_id OR target.id::text=t.satellite_target
```

`public.tournaments.satellite_target` is of type `uuid`. Casting the left side
to `text` therefore asks Postgres for `text = uuid`, which has no operator, and
the statement raises the first time that branch is planned.
`fn_get_club_welcome_package_reset_impact(uuid)` is read immediately before the
certification's own probe, so every run has died there since the fragment
shipped. It was the eighth distinct blocker on that certification.

## The fix

One cast, removed. `20261003035741_satellite_target_is_a_uuid_not_text_in_the_welcome_reset_gra.sql`
rewrites both `fn_unwind_unused_first_club_welcome_package(uuid,uuid)` and
`fn_get_club_welcome_package_reset_impact(uuid)` by exact-fragment substitution
to compare `uuid` to `uuid`:

```sql
WHERE target.id=t.satellite_target_id OR target.id=t.satellite_target
```

The predicate's intent is unchanged. A SATELLITE feeder is in the package graph
when its target is one of the package's tournaments, reached through either the
current `satellite_target_id` backlink or the legacy `satellite_target` column,
and both columns hold the target's uuid.

The migration reads the column type out of `pg_attribute` and refuses with
`SATELLITE_TARGET_IS_NOT_UUID_REFUSED` rather than install the other mistake; it
refuses unless the fragment appears exactly once; it proves the substitution
reverses to the byte; it re-reads both functions and requires every catalogue
attribute (owner, acl, config, secdef, volatility, parallel safety,
leakproofness, language, return type, kind) to be identical; and because a
plpgsql body is not planned at creation, it plans the repaired comparison itself
over no rows, so the migration fails rather than production if the operator
still cannot be resolved. Replay is a no-op.

## Why it passed review and rehearsal, and the line that allowed it

`scripts/ci/test-club-welcome-package.py` built its rehearsal fixture with
`satellite_target text`. The local Postgres run resolved `text = text` and went
green while production could only ever raise. That is the root of the root: a
fixture that does not carry production's type cannot refuse a type error. The
fixture column is now `uuid`, and
`tests/new-club-opening-zero-state-database.law.test.ts` pins it there.

## The proof pin

`20261003021809`'s own `@live-proof` required the literal
`target.id=t.satellite_target_id OR target.id::text=t.satellite_target` to be
present in both bodies, so repairing the function would have turned that proof
false in `check-migrations-are-live.mjs`. The pin was moved in the same commit:
that migration's `@live-proof` line now names the uncast comparison, with a note
saying why, while its `DO` blocks are left exactly as applied because they are
the record of what it did and their preimage digests describe the body it found,
not the body now live. The law test asserts the moved pin both ways - the live
proof names the uncast form and no longer names the cast one.

## Not fixed here, and not mine

- The `57014` statement timeouts later in the same certification are a multixact
  SLRU capacity problem that needs a Postgres restart-level config change.
- No detector, sweep, repair job or backfill was added. The cause is the line,
  and the line is changed (CLAUDE.md 10.11, 10.12).
