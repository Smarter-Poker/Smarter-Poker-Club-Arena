# Club settlement floor: discovery behaviour

PR #4980 fixed a real stall - the weekly settler was head-of-line blocked
behind two structurally uncertifiable weeks - and shipped
`20260920232503_club_settlement_floor_bounds_standalone_weekly_discovery.sql`,
which clamps the three standalone-club discovery sites in
`fn_process_weekly_accounting_scope` to `public.club_settlement_floor`. The
sibling fixture `../club-settlement-floor` proved the floor's arithmetic and
the shape of the rewrite. Nothing proved the **behaviour**: that a below-floor
club week stops re-entering discovery and that the later week is reached. This
fixture closes that gap.

## Why it could not be proved before, exactly

Not the migration's preimage guard. `scripts/dev/test-union-weekly-basis.py`
already installs `20260920232503` unmodified, and its
`weekly_coordinator_preimage_drift` guard passes there, because that cluster
carries the exact installed `fn_process_weekly_accounting_scope`.

The blocker is the run journal. `../full-weekly-accounting/schema.sql` is a
2026-09-14 catalog capture, and on that date `public.union_accounting_runs`
was still union-only: `PRIMARY KEY(union_id,period_start,period_end)`,
`union_id NOT NULL`, and no `standalone_club_id`, `scope_kind`, `scope_id` or
`last_scheduler_visit_at`. Every term of the coordinator's standalone-club
discovery reads those columns, so on that base the club branch cannot execute
at all - it fails 42703 long before a floor predicate is evaluated.

`../weekly-scheduler-fairness` has the right journal shape, because it applies
component `20260914142600` itself, but it builds the whole coordinator from
the weekly-v3 components. That body is not the installed one, so
`20260920232503` refuses there with `weekly_coordinator_preimage_drift` - and
it should: the guard is doing its job.

## What this fixture does

`installed-run-journal.sql` brings the captured journal to the shape production
actually has, using the reviewed source of that shape verbatim - components
`20260914142600` and `20260914154500`, and migration `20260917195207` - and
then reads the result back against the column, constraint and index inventory
captured read-only from production on 2026-09-21. It touches no coordinator,
floor, payer or document definition, and it refuses if the installed journal
has moved.

`seed.sql` stands up five scopes that differ only in the thing under test, each
carrying the production shape of the stall. `regression.sql` then calls the
installed coordinator once per scope and asserts:

* **(a)** the below-floor club week is not attempted again - status, attempts,
  timestamps and result untouched - while a club with **no** floor still
  re-enters its oldest outstanding week, so this is not a blanket suppression;
* **(b)** the first week above the floor is reached, and for club scope
  actually completes on the v3 basis; the union side reaches its first week
  above `union_settlement_floor` with its below-floor row untouched;
* **(c)** the head-of-line `EXIT` from `20260907164234` still fires: a club
  whose first week above the floor fails for a real, resolvable preparation
  refusal does **not** get its next due week worked, while the club whose
  earlier week succeeded does;
* **(d)** `accounting_deferred_obligations` still reconciles to a fresh recount
  of the real pending `rakeback_periods` rows after the coordinator has run,
  and those rows are still pending - deferring is not paying or cancelling.

## Boundaries

The floor is bound at three discovery sites. Site 3, the exact-scope club
cursor, decides which week is worked and is exercised end to end here. Sites 1
and 2 are the scheduler's eligibility window and its per-week due check; a
scheduler-wide call on this shared cluster raises
`closed_original_book_barrier_required` for an unrelated union fixture, so
their clamp is asserted as the exact arithmetic the installed definition
performs, plus the structural three-site assertion in the sibling fixture.

This fixture does not qualify installation, deployment, the production
scheduler, provider delivery or any financial release, and the obligation rows
it records are fixture rows, not a payment.
