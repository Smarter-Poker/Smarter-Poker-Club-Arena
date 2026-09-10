# A declared guard change is recorded, not raised

2026-09-10

## What happened

13:28 - `a_maintenance_kind_registered_as_info_is_recorded_not_raised` redefined
`fn_ca_journal_append_only`. Reviewed, applied, recorded, byte-identical in the
repo.

14:25 - `fn_ca_guard_defs_watch` compared that guard against its stored baseline,
found them different, and opened INFO notice `91032e79`. Its text ends: "Then
resolve this notice - it does not close itself."

So a correct migration put an item on the drift board that a human has to clear
by hand, and **every** deliberate change to any of the 28 watched guards does the
same. This is the third instance of one shape in a single day: the append-only
notice re-raising itself once per cleanup, the hand-refusal detector re-reporting
117 refusals from a cause already fixed, and now the guard watcher reporting our
own reviewed work.

## What the diff actually was, proved

Not asserted. History id 5294 is the definition as of 2026-09-09 10:25; id 6078
is the live one. Applying that migration's two documented substitutions to 5294
reproduces 6078 **byte for byte** - md5 `ac9d66e60d077d886981c428c71e5c3c`, the
same hash the notice carries as `new_hash`. 527 characters added, nothing else
touched.

That reconstruction is repeated as an assertion inside the correcting migration,
so it would have **refused to close the notice** if anything other than those
two substitutions had touched the guard.

## The rule

The registry pattern the platform already uses for maintenance kinds: a
**declared** change is recorded, an **undeclared** one is raised.

`fn_ca_declare_guard_redefinition('<guard>', 'migration <name>')` lets a
migration that deliberately redefines a watched guard move the baseline in the
**same transaction**, naming itself. By the time the watcher next runs, the
baseline already is the live definition, so there is nothing to report. It
refuses an empty reference, refuses a name that is not on the watchlist, and
refuses to baseline a guard that does not exist.

`ca_guard_defs` gains `declared_ref` and `declared_at`. They are NULL when the
watcher moved the baseline itself after observing a change nobody declared,
which is how you tell a recorded change from an observed one.

## The watcher is not weakened

Nothing about `fn_ca_guard_defs_watch` changed. Not muted, not narrowed, same
severity. A guard redefined by anything that did not declare itself - a hand edit
on the box, an unreviewed `CREATE OR REPLACE`, a rollback that silently restores
old text - still moves the hash away from its baseline and still raises exactly
as loudly as before. What stops is the board reporting work that was already
reviewed.

The migration also asserts that **no** watched guard is currently sitting away
from its baseline, so nothing else was quietly waiting to fire.

## What stops the next migration forgetting

`tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts`. Any migration
dated on or after this one that redefines a watchlisted guard - by
`CREATE OR REPLACE`, or by the asserted-substitution shape - must call the
declaration. The watchlist is **parsed out of the newest migration that defines
`fn_ca_guard_watchlist`**, so adding a guard to the watchlist extends the law
automatically instead of quietly leaving the new guard uncovered.
