# Every pull request in the repo was red

**2026-09-07** — branch `fix/a-club-cannot-be-deleted-while-a-drill-arm-has-no-index`

Found while checking why three of my own pull requests were blocked. They were
not blocked by anything I wrote. **Every open pull request in the repository
was failing CI**, and had been for hours.

## The evidence

Twelve consecutive `CI — Build & Type Safety` runs, sampled at 05:27 UTC, every
one a different agent on an unrelated branch:

```
docs/the-jackpot-drill-runbook                    failure
fix/union-week-ends-midnight-pacific              failure
docs/phase-5-the-partition-blocker-is-not-...     failure
agent/cowork-bbj-audit/phase-4-prove-it-li...     failure
agent/cowork-pgrst/fix/pgrst002-resilience        failure
cowork-claude-feefwd                              failure
fix/auth-join-and-delete-defects                  failure
agent/cowork-claude/the-drain-outlives-the...     failure
fix/what-is-actually-on-the-core                  failure   <- mine
fix/a-tournament-with-one-player-left-...         failure   <- mine
fix/an-empty-histogram-is-not-an-idle-loop        failure   <- mine
```

The failing step, on all of them: `Supabase Invariants — A Club Stays
Deletable`. It names exactly one offender.

## One missing index

```
bbj_drill_arms.club_id   (bbj_drill_arms_club_id_fkey)
```

`bbj_drill_arms` is new — it belongs to the bad-beat-jackpot drill work. It was
created with a foreign key into `public.clubs` and three indexes
(`bbj_drill_arms_pkey`, `bbj_drill_arms_one_live_per_table`,
`bbj_drill_arms_armed_at_idx`), **none of which leads on `club_id`**. Postgres
does not index a referencing column for you, so every `DELETE FROM clubs` had
to sequentially scan this table to prove no arm referenced the row.

The gate exists because that is not cosmetic. Its own message: the
club-retirement RPC runs inside a PostgREST request cancelled after a few
seconds, and when it is cancelled a certification fixture and its 100,000 chips
stay in Club Arena. **That has already happened once.**

## The fix is the one the check prints

```sql
CREATE INDEX IF NOT EXISTS idx_bbj_drill_arms_club_id_fk
  ON public.bbj_drill_arms (club_id);
```

Plain, not `CONCURRENTLY`, and that is a measurement rather than a shortcut:
`bbj_drill_arms` holds **0 rows in 64 kB**. A plain build is instantaneous and
its SHARE lock is on an empty table nothing is reading. The check's advice to
build concurrently is for the case it also names — _"867,780 rows took 25
seconds"_ — which is not this one.

The migration asserts before it acts: it aborts if the table is gone, and
aborts if the foreign key into `clubs` no longer exists, because then the index
would be answering a problem that does not exist. Its post-check requires a
**non-partial** index leading on `club_id` — the gate's own closing line says a
partial index cannot count, since a foreign key check must find the rows the
predicate hides, and asserting that is better than trusting it.

Verified after applying:

```
OK - every single-column foreign key into public.clubs has an index that can answer it.
```

## Not my table, and fixed anyway

`bbj_drill_arms` belongs to another programme. CLAUDE.md rule 8 is explicit:
_"If you find main already red, fixing it comes before your own work. You
cannot ship past it anyway."_ Three of my pull requests were blocked by it and
so was everybody else's. Nothing about the drill's design is changed here —
this adds only the index its own foreign key already implies.

## The other thing this shows

A single missing index on a brand-new table stopped **every agent in the
estate** from merging, for hours, and the failure surfaced as a red check on
work that had nothing to do with clubs. The gate did its job perfectly. What
nobody had was the second half of 10.86 rule 3: a reader who notices that the
_same_ check is red on _every_ branch at once, which is a different and much
louder signal than one branch failing.

`check-main-is-green.mjs` watches `main`; this failure lived on pull requests,
where nothing aggregates. That gap is worth closing and is not closed here.

## Files

- `supabase/migrations/20260907052848_a_club_cannot_be_deleted_while_a_drill_arm_has_no_index.sql` (applied)
