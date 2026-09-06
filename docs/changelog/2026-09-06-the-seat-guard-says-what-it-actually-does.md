# The seat guard says what it actually does (2026-09-06)

`fn_ca_guard_seat_creation` is the money guard armed this morning: chips reach
a seat through the engine or a declared money path, or not at all. Its header
carried one sentence that was wrong:

> ARMED 2026-09-06, after the dry run stayed empty across 170,942 seat
> creations. **It LOGS the refusal before raising it**, so a refused seat names
> its own caller and the allowlist can be corrected in minutes.

It does not log, and it cannot. A `RAISE` in a `BEFORE` trigger aborts the
statement and takes the trigger's own `INSERT` with it, so a guard cannot
write its own refusal anywhere. The function says exactly that, correctly,
forty lines further down at the `RAISE`:

> No table write here: a RAISE in a BEFORE trigger aborts the statement and
> would take the row with it (measured). The evidence travels in the error.

So a function that refuses money movements contained two statements
contradicting each other, one of them false. An agent debugging a
`SEAT_NOT_FUNDED` refusal follows the wrong one to `ca_seat_guard_dryrun`,
finds it empty, and concludes the guard never fired. The Table Stakes handoff
has carried this since the guard was armed, deferred because correcting a
comment costs a ~28-second PostgREST schema reload.

The corrected paragraph says what is true and why the obvious alternative is
impossible, so the next reader does not re-derive it:

> A refused seat NAMES ITS OWN CALLER IN THE ERROR - the money path, the JWT
> role, the application_name, the table, the seat and the stack. IT DOES NOT
> LOG. [...] An agent reading the old sentence goes looking in
> `ca_seat_guard_dryrun`, finds it empty, and concludes the guard never fired.

## Only the comment changed, and that is proven, not asserted

Re-emitted verbatim from the live definition with one paragraph replaced. In a
rolled-back transaction, the old and new bodies were compared with comments
stripped:

```
code_identical_ignoring_comments  t
chars_changed                     618        (all of it comment)
security_and_grants_unchanged     prosecdef t, owner postgres, search_path=public
```

The migration also asserts, at apply time, that the false sentence is gone,
the true one survives, all five allowlisted money paths are still named, the
count of early `RETURN NEW` branches is unchanged, and it still raises
`SEAT_NOT_FUNDED` - so a re-emission cannot quietly widen a money guard.

## A note on probing this guard

A behavioural probe from `psql` cannot test the refusal: `fn_caller_is_engine()`
deliberately trusts a session with no JWT (psql, pg*cron, a migration), so an
undeclared insert from a superuser session is \_supposed* to pass. My first
probe read that as "the guard let a 999-chip seat through" and it was the probe
that was wrong. Comparing the compiled body is the honest check for a
comment-only change, and it is the one that ran.

## The law moved with the mechanism (CLAUDE.md 5.8)

`tests/theSeatGuardIsArmed.law.test.ts` required that the LAST migration
declaring the guard be `_the_seat_guard_is_armed.sql` itself. That pins the
migration's **identity**, not the guard's **property**, so a comment
correction that leaves the compiled body byte-identical failed a law about
arming.

Its other two assertions are the real ones and both still pass unchanged: the
live body raises `SEAT_NOT_FUNDED`, and it is not the dry-run body. What is
kept from the third is deliberateness - a migration may re-declare the guard
only by naming itself in `SANCTIONED_REDECLARATIONS`, so the body can never be
swapped in a file nobody reviewed. What is dropped is the part that would have
pushed the next agent to weaken the law or to leave a false sentence in a money
guard rather than touch it.
