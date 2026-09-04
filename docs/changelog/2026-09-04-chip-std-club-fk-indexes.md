# A club cannot be deleted in time, so nothing ever deleted one

2026-09-04, 00:16-00:20 UTC. Migrations `20260904001605` and `20260904001715`.

## What happened

At 23:33 UTC on 2026-09-03 the Club Create Certification ran on `dcdba5e5` - the
merge of #2898, the build that was supposed to have made stranded fixtures
impossible - and reported:

```
PASS Custom And Placeholder Club Creation Certified For 89e03439..., 7abc31e6...
Fixture Cleanup Failed For 89e03439...: canceling statement due to statement timeout
Fixture Cleanup Failed For 7abc31e6...: canceling statement due to statement timeout
Error: Certification leaked 2 fixture club(s) into Club Arena
```

The guard added in #2898 did exactly its job: it detected the leak and failed the
run. The cleanup it guarded was impossible to complete. Two fixture clubs and
200,000 chips stood in Club Arena, an hour after the fleet of fifteen had been
retired.

I found this while re-measuring production for the handoff document: `clubs` read
**6**, not the 4 Dan named.

## Why the cleanup was impossible

`public.clubs` has seventy foreign keys pointing at it. A `DELETE` makes
PostgreSQL check every one of them, and a check with no usable index is a
sequential scan of the child table. `EXPLAIN (ANALYZE)` on the delete itemised
it:

```
Trigger for constraint rake_records_club_id_fkey    time=1287.422 calls=1
Trigger for constraint table_seats_club_id_fkey     time=  73.776 calls=1
```

plus `game_management_events`, 867,780 rows, with no index on `club_id` at all -
which the retirement function's own `DELETE ... WHERE club_id = $1` also needed.

Seven of the seventy keys had no index that could answer them. **Two of the seven
looked indexed and were not**: `idx_rake_records_club_created` leads on `club_id`
but carries `WHERE rake_amount > 0`, and `idx_table_seats_club_active` leads on
`club_id` but carries `WHERE left_at IS NULL`. A partial index cannot answer a
foreign key check, because the check must find exactly the rows the predicate
hides.

My first audit asked "is there an index whose first column is this one" and
answered yes for both. The question has three parts, not one: **valid,
non-partial, and leading on the referencing column.**

## What was tried and rejected

The obvious fix is to give the function a bigger budget:
`SET statement_timeout TO '60s'` on `fn_ca_retire_certification_club`. It does not
work, and I proved that before relying on it rather than after. PostgreSQL arms
`statement_timeout` when the statement starts; a `SET` inside the function does
not re-arm the timer for the statement already running. Probe: a function declared
`SET statement_timeout TO '30s'`, sleeping 6 seconds, called under a 3 second
session timeout, was cancelled at 3 seconds.

The only real fix is to make the work fit the budget.

## What shipped

**`20260904001605`** - thirteen indexes, six for keys with no index at all and
seven for keys whose only candidate was partial or absent. The two large ones
(`game_management_events` 25.0s, `rake_records` 8.1s, `table_seats` 6.3s) were
built `CONCURRENTLY` against production first, because a plain build takes a SHARE
lock and 25 seconds is 25 seconds the engine cannot write a game management event.
The migration therefore says `IF NOT EXISTS`: a no-op on production, and the thing
that builds them on any database restored from these migrations. It ends with a
self-check that raises if any single-column key into `clubs` is still
unanswerable.

**`20260904001715`** - `fn_ca_fk_index_gaps(p_parent text DEFAULT 'public.clubs')`,
a read-only `STABLE SECURITY DEFINER` function returning the gaps as JSON,
revoked from `PUBLIC`, `anon` and `authenticated`, granted to `service_role`.
Nothing schedules it. It exists so the repository can ask production the question
on a pull request.

**`scripts/ci/check-club-fk-indexes.mjs`** - the gate that asks. A new table with
a `club_id` and no index now turns the branch that introduced it red, instead of
surfacing as a stranded fixture weeks later.

Dan's standard for this programme is explicit: _"WE SHOULDN'T NEED THOSE DETECTORS
OR WATCH DOGS ... NOT TO HAVE WATCH DOGS AND CRONS RUNNING ALL OVER THE PLACE. WE
MUST BE PERFECT!"_ This is not a detector. It runs once per pull request, it
writes nothing, it raises no incidents, and what it protects is a structural
property - a club can be deleted inside a request - rather than a symptom.

## Proof

Both fixtures retired through the same PostgREST door, as the same `service_role`
the certification uses:

| Fixture                                                                   | HTTP | Time  | Chips retired |
| ------------------------------------------------------------------------- | ---- | ----- | ------------- |
| `89e03439-81e0-4197-b0c7-ec406dc8e3b3` (`Crest Cert 1788478854825-cjxkf`) | 200  | 2.43s | 100,000.00    |
| `7abc31e6-6ead-4d40-a9ee-627075d254f7` (`Preset Crest Cert 178847885482`) | 200  | 2.58s | 100,000.00    |

Before the indexes, the same two calls returned `57014 canceling statement due to
statement timeout` at 11.36s and 8.75s.

After:

- `clubs` = **4**: Club JAQK, SHARK CLUB, Midway Union, Deep Stack Society.
- 200,000.00 left as **two declared burns** to `chip_retirement`, a
  non-circulating store, so the supply meter reads them as retired rather than as
  chips that vanished.
- `fn_ca_fk_index_gaps('public.clubs')` returns `{"gaps": []}` for `service_role`
  and `401` for `anon`.

## Law

`tests/a-club-stays-deletable.law.test.ts`.
