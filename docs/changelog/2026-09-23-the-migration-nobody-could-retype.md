# The migration nobody could retype

2026-09-23

## What was wrong

`supabase/migrations/20260922143541_club_and_union_diamond_commerce.sql`
merged on 2026-09-22 (PR #5077) and never reached the database. Read from
rows on 2026-09-23:

- absent from `supabase_migrations.schema_migrations`, while that history ran
  through `20260923150831` - so later migrations had been applied straight
  over the gap;
- `fn_ca_commerce_claim_due_renewals`, `fn_ca_commerce_deliver_due_notices`
  and `fn_ca_commerce_execute_renewal` returned zero rows in `pg_proc`;
- `server/src/index.ts` starts the commerce renewal consumer unconditionally
  at boot, so `auto-deploy-hetzner`'s gate **Prove The Exact Engine Has Every
  Production Door** refused every engine build after it.

The gate was right. The engine stayed on `8825af51817f379c4261658ca29ecc9d8d81932d`
(sealed 2026-09-18) with `stalledTableCount: 65` and `deadStalledCount: 65`
while it dealt on (`handsInFlightTotal: 82`). CLAUDE.md 10.82 in one line:
merged is not landed.

## Why nobody had applied it

`check-migrations-are-live.mjs` finds this exact condition and its remediation
line says to apply the file with the Supabase MCP `apply_migration`. That tool
takes the SQL as a **call argument**. This file is 126,446 bytes, so applying
it that way means reproducing 2,063 lines of a money migration by hand, from a
transcript, in one message. That is not a safe operation on a file carrying
purchase, refund and renewal paths, and it is larger than a single tool call
can carry - which is how the file sat unapplied for a day while the whole
engine lane was stopped behind it.

**The remediation existed; it just had a size it could not cross.** Nothing
was broken and nobody was careless: the instruction was correct and
unexecutable, which is worse than a missing instruction because it reads as a
plan.

## The fix

`scripts/ci/apply-recorded-migration.mjs` and the dispatch-only
`Apply Merged Migration` workflow apply **the file**: the runner checks out
the commit, reads the bytes off disk and sends them once, through the same
`secrets.DATABASE_URL` credential boundary the auto-deploy doors gate already
uses. Nothing is transcribed, so nothing can be mistranscribed.

It is deliberately narrow:

- **one named file per dispatch.** It never discovers work for itself, has no
  schedule and no push trigger. It is not a repair job (CLAUDE.md 10.12): it
  writes no money, retries nothing, and fixes nothing up after the fact.
- **it refuses a file that is not one transaction.** The whole file goes as a
  single simple query, so a file without its own `BEGIN`/`COMMIT` would
  autocommit statement by statement - up to one ~28s PostgREST reload each,
  and a partial schema if one failed (CLAUDE.md section 2 rule 1).
- **it refuses inside :50-:03 UTC** rather than letting the
  `ca_break_window_refuses_ddl` event trigger abort the transaction (section 2
  rule 8, section 13). The event trigger is still the real guard.
- **it reads history with a plain `SELECT`**, never `list_migrations`, which
  runs five no-op `ALTER TABLE`s and reloads PostgREST on every call.
- **three outcomes, not two** (CLAUDE.md 10.86 rule 1): `0` applied or
  already-applied, `1` refused, `3` could not tell - and on `3` nothing is
  sent. "Already applied" is stated separately from "applied" so a re-dispatch
  cannot read as success twice.
- **one attempt.** No retry loop (section 2 rule 2).
- **the reader is the person who dispatches it** (CLAUDE.md 10.86 rule 3).
  It is operator-invoked, so the run's own conclusion is the answer, and the
  job summary states it in words.

It also records the history row under the **file's** version rather than the
apply time. Supabase's transport stamps its own - measured on this database,
version `20260923150831` holds the file `20260923131325_...` - which is why
`check-migrations-are-live.mjs` has to match on name. Recording the true
version keeps the repo and the history answering the same question.

## The migration itself, and the price row it deletes

The file installs a diamond commerce catalog for club and union operating
capacity: 13 new `ca_commerce_*` tables, 35 functions, purchase, refund and
renewal money paths. Every foreign key it creates points at a table created in
the same transaction - **none to a hot relation**, which is what section 2
rule 7 was written about.

Its third executable statement is:

```sql
DELETE FROM public.feature_pricing WHERE feature = 'club_creation';
```

That is the one statement touching existing state, so it was settled under
CLAUDE.md 10.9 before anything was applied. Read from rows:

- the row was `club_creation`, 100 diamonds, `permanent`, "Create additional
  club", seeded 2026-01-24;
- `feature_purchases` holds **0** rows for it, ever, out of 46 total, and no
  `diamond_transactions` row mentions it - **nobody has ever bought it and
  nobody is mid-purchase**;
- the two functions whose source mentions `club_creation` do not price it:
  `fn_ca_mint_velocity_watch` matches inside an alert sentence ("mass club
  creation") and `fn_create_club_atomic_membership_impl` matches only
  `club_creation_requests` and the words "Club creation is temporarily
  unavailable". **No creation path ever read the price row**, which is what
  the migration header claims;
- `fn_wheel_spin_v2` and `fn_wheel_state_v2` compare `feature_pricing` against
  an expected set, and that set is `throwable`, `rabbit_hunt`,
  `time_bank_seconds` only - `club_creation` is not in it, so the wheel does
  not get requalified by the delete;
- the client is already defensive. `VIPService.ts` only offers what
  `loadFeaturePricing()` confirms the server prices, so the row's removal
  stops the door being offered rather than breaking it. The `PRODUCTION_PRICES`
  fixture in `tests/cosmetic-ownership-integrity.test.ts` is mock input, not a
  live-DB pin - it already lists `theme_unlock`, which production does not
  have.

So `fn_purchase_feature_v2` would have sold `club_creation` to anyone who
asked - 100 diamonds for a row that grants nothing. Deleting it is a defect
fix, not a pricing change, and it takes nothing back from anyone because
nobody ever paid it.

**Probed first, in a transaction that rolled back** (CLAUDE.md 11.5: one call,
one self-aborting `DO` block ending in `RAISE EXCEPTION`, where the error is
the success case):

```
PROBE_OK before=1 deleted=1 after=0 total_before=69 total_after=68
         inbound_fks=[none] surviving_purchases=0
```

Exactly one row, no inbound foreign keys to `feature_pricing` so nothing
cascades or is orphaned, and no surviving purchase. The numbers applied are
the numbers the probe returned.

The rest of the file was checked against production before it was sent: all 20
external columns it reads exist, `deduct_diamonds` matches its 8-argument
call, `add_diamonds_to_balance`'s sixth parameter defaults so the 5-argument
call resolves, and there were **0** existing `ca_commerce_*` relations or
functions to collide with. Its own closing `DO $assertions$` block refuses to
commit unless the catalog is whole and **no purchase or trial exists** - so
the install moves no money by construction.

## What happened when the engine was taken through the lane

The migration was applied at 17:06 UTC by
`Apply Merged Migration` run 35893325790: `committed in 678ms`, recorded
`version=20260922143541 name=club_and_union_diamond_commerce`. Verified from
rows, not from the log: the three doors are 3 of 3 in `pg_proc`, 14
`ca_commerce_*` tables and 35 functions exist, 16 products and 9 published
prices, **0 purchases and 0 trials**, and `feature_pricing` went 69 to 68 with
`club_creation` gone. The probe had predicted `total_after=68`; that is what
committed.

**The doors gate then passed.** `auto-deploy-hetzner` run 35869125718 was
re-run with the root cause fixed. Its target `a867a14e76` (#5119) carries a
server tree byte-identical to current `origin/main` (`ade256d2d7`), so this
was current engine code, not a stale request. **Prove The Exact Engine Has
Every Production Door: success** - the check that had refused thirty
consecutive runs.

The release then requested an **event-owned recovery window** (the September
17 owner update, `engine-recovery-window-v1`), froze the platform, drained
`handsInFlightTotal` to 0 and counted down. It did not cut over, and the run
failed at **Dispatch the staged SHA through the durable Hetzner intake**. The
platform thawed correctly: maintenance returned to `idle` and the fleet
resumed dealing (145 hands in flight within a minute).

### Two different F06 refusals, and only one of them is about a dead table

`/health` during the window said the restart certificate was held shut by
`unparkedReasons: { f06_preparation_unresolved: 1 }`. That one IS a dead
table: `6da98abe`, tournament `05c8bb91` ("2 Chip Deep Stack Spin PLO6"), and
it is **closed, COMPLETED since 2026-09-22 14:10, 0 seats, 0 chips, and it
holds no `engine_tournament_leases` row at all**. There is no durable F06
state for it anywhere in the database, so there is **no platform path to
clear it**: the permit exists only in the running engine's memory.

The bounded gate that would make this self-healing already exists on main -
`MaintenanceBreak.F06_UNRESOLVED_GATE_MS = 10 minutes` - but it arrived in
`f85e90aa6b` (#5003), which is **not an ancestor of the running engine**
`8825af51` (2026-09-18 16:16). The fix for the wedge is behind the wedge, and
it stays there until some release gets through.

**The release did not actually die on that one.** The legacy checkpoint guard
refused first, and thanks to #5119 it named its phase:

```
reason: f06_custody_not_drained   retryAllowed: false
failedTable: 9e432569-5ebc-467a-9972-e450dfc0b296
tournament:  7c6277e7-921d-4651-91bc-15071a3884be
stopped=true terminal=true seats=6 banks=0 metaSeatedWithoutBank=6
permitPhase=attempted   fleetF06=38
```

That table is a different animal and **must not be cleared as terminal**.
Read from rows: `tables.status = 'running'`, tournament `7c6277e7`
("Morning Free Buy (NLH)") `status = 'RUNNING'`, **6 seats still open holding
124,007 chips**, untouched since **2026-09-19 14:27**, and **no
`engine_tournament_leases` row**. A RUNNING tournament with six seated stacks
and no engine driving it is a stranded event, not a drained one, and
`banks=0 / metaSeatedWithoutBank=6` says its custody was never banked.

So the 10.9 test fails on the evidence for this table: chips ARE at stake.
Clearing this permit to unblock a deploy would be settling six players'
stacks by side effect, which is the opposite of what 10.9 authorizes. It
needs its own settlement - finishing order, prize pool and payouts read and
decided - and that is a separate piece of work, not a step in a release.

### Where this leaves the engine

Production still runs `8825af51817f379c4261658ca29ecc9d8d81932d`. The
migration blocker is gone for good and the doors gate is green; what now
refuses the release is `f06_custody_not_drained` on `9e432569`, with
`retryAllowed: false` and the guard's own instruction not to retry. Run
35869125718 is the evidence.
