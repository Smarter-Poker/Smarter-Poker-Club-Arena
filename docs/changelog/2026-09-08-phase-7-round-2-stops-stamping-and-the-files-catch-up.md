# Phase 7 of 8 (union accounting): round 2 stops stamping, and the files catch up

2026-09-08. Club Arena. Five migrations, four of which were already running in
production when this was written.

## The short version

Round 2 of the union close paid each (club, agent) pair by summing that pair's
`agent_commissions` rows for the period and then **stamping every one of those
rows** with `settled_at`. On a 2 GB, eight-index table that is 2,124,321 row
updates for a single week, none of them HOT because `settled_at` sits inside a
partial index predicate. Measured 2026-09-07: 3,180 rows/s, 668 s projected for
round 2 alone, which is why the close job's ceiling had been raised to 2,400 s.

Phase 7 removes the write instead of paying for it. A commission row is now
settled when **either** its own `settled_at` is set (a claim, or history)
**or** it falls inside a period that `agent_commission_settlements` says round 2
already paid for its pair. Round 2 writes one settlement row per pair per
period rather than two million stamps.

## Why not a plain watermark

Because "everything before T is paid" is false here, and quietly so:

- 1,118,785 rows already carry a `settled_at`;
- 83 pairs have settled and unsettled rows **interleaved in time**, because the
  agent claim (`fn_agent_claim_commission`) settles batches in no particular
  order;
- 239 pairs hold **1,008,358.25** of unsettled legacy commission older than any
  period round 2 will ever pay for.

A watermark would have marked that last group paid without paying it. The
period model is the version that does not lose anyone's money.

## The three follow-ups, each a defect the previous migration introduced

These are separate migrations because each was found by measuring the one
before it, on production, under live load.

**`20260908031445` - the predicate must inline, or it is a per-row call.**
The shared predicate `fn_agent_commission_paid_by_period` shipped as
`LANGUAGE sql STABLE SET search_path TO 'public'`. Postgres will not inline a
SQL function carrying a `SET`, so it stopped being a semi-join the planner
could fold into the scan and became a function call per row. Invisible on a
scoped read; fatal on the two readers that walk the whole ledger - `fn_club_unclaimable_commission(NULL)` scans 2,851,735 rows and **timed out at
150 s** in the verification probe that followed the model change, a read that
had answered in seconds an hour earlier. Fixed by dropping the `SET` (with an
explicit `ALTER ... RESET`, since `CREATE OR REPLACE` does not reliably clear
`proconfig`) and by spelling the two whole-ledger readers out as `NOT EXISTS`
rather than trusting inlining.

**`20260908032512` - the owed set is an anti-join, not a set-returning detour.**
"What a pair is still owed" was expressed as the complement of its paid periods
via two set-returning functions. Readable, correct, and materialised by the
planner instead of folded into an index scan. Measured on one Deep Stack pair
with 14,485 open rows:

|                                | no paid period | one paid period |
| ------------------------------ | -------------- | --------------- |
| batch of 200 through the SRF   | 28 ms          | 60 ms           |
| the same batch as an anti-join | 1 ms           | 2 ms            |

83 pairs took 7,633 ms, most of it materialising sets the planner could have
skipped. The four hot paths now ask the question the way the index answers it.

**`20260908033445` - the claim records what it covered instead of stamping it.**
Round 2 stopped stamping; the agent claim had not, and was then the only writer
of its kind left. Measured on the 2.6 GB nine-index table under live load:

```
select the batch of 1,000 (anti-join, index-only)      78 ms
UPDATE those 1,000 rows SET settled_at = now()     10,930 ms   (10.9 ms/row)
the whole claim, 1,000 rows                        17,757 ms
```

The `authenticated` statement_timeout is 8 s, so the function's **own default
batch size could not finish inside it** - a defect that predates this phase and
that the phase's measurements surfaced. The claim now takes a per-pair advisory
lock, reads a cutoff (the `created_at` of the batch-th oldest open row, which
is free because `agent_commissions_open_idx` is already in that order, clamped
to five minutes ago for the same in-flight margin round 2 uses), and records
the interval it covered.

## Verified after the fact, not assumed

```
fn_club_unclaimable_commission(NULL)      776 ms   (was: timeout at 150,000 ms)
agent_commissions total                 3,984,477 rows
  carrying settled_at (history)         1,118,785
  open                                  2,865,692
agent_commission_settlements                    0 rows (round 2 has not yet run
                                                  under the new model)
```

The stamped count matches the 1,118,785 the model change was designed around,
so nothing moved underneath it.

## The fifth migration: the commission ledger grants no writes to a browser role

Found while re-reading every authority over `agent_commissions` for the model
change. Both commission tables carried the full default grant set:

```
agent_commissions              anon           DELETE, INSERT, SELECT, UPDATE
agent_commissions              authenticated  DELETE, INSERT, SELECT, UPDATE
agent_commission_settlements   authenticated  DELETE, INSERT, SELECT, UPDATE
```

**Stated honestly: this was defence in depth, not a live hole, and no incident
is being reported.** RLS is enabled on both tables and every policy on them is
SELECT-only for `authenticated`, with writes reserved to `service_role`; `anon`
holds no policy at all, so its grants were already unreachable.

It is still worth removing, because the grant is the half of the pair nobody
looks at. RLS is what gets reviewed and a policy is a visible object; a
table-level INSERT grant does not appear in `pg_policies` and survives every
policy rewrite. The day somebody adds a permissive policy so an agent can
acknowledge a row - the ordinary next request on this table - the grant is
already there and the write lands on a money ledger. Two things would have to
go wrong; this removes one of them permanently.

Nothing breaks: `fn_agent_claim_commission`, `fn_settle_round2_club_to_agents`
and `fn_club_unclaimable_commission` are all `SECURITY DEFINER` owned by
`postgres` and never consult the caller's table grants, and the engine writes as
`service_role`. `anon` loses SELECT too, matching what `20260906091809` did to
`chip_transactions`. The `REVOKE ALL` / re-`GRANT` idiom is copied from
`20260906091809` and `20260906091646` on purpose, so the estate has one way of
saying this rather than two.

Probed first inside a single self-aborting `DO` block (section 11.5 - over the
Supabase MCP a transaction cannot span two calls, so the probe has to be one
call that ends by raising). Live grants after applying:

```
agent_commissions             authenticated  SELECT
agent_commissions             service_role   all
agent_commission_settlements  authenticated  SELECT
agent_commission_settlements  service_role   all
anon                                         (absent from both)
```

`GRANT`/`REVOKE` does not fire `pgrst_ddl_watch`, so this cost no PostgREST
schema reload (CLAUDE.md section 2, rule 5).

## The process defect, which is the part worth keeping

**Four of these five migrations were applied to production and existed in no
file.** 83,933 characters of SQL - the entire round-2 model change and its three
follow-ups - were live on the platform, on `main` nowhere, and on disk nowhere.
They were recovered for this branch out of `supabase_migrations.schema_migrations`,
which stores the statements the database actually executed, so the files here
are what production ran rather than a reconstruction of it.

This is not a new class of failure and the estate already has the right guard
for it: `applied-migrations-recorded.yml` asks the direction no PR gate asks - not "does this branch's migration exist in the database" but "what has the
database applied that nobody wrote down" - and it files an issue. It runs at
07:25 and 19:25 UTC. These were applied between 02:56 and 03:34 UTC, so the
07:25 run would have filed that issue in about three and a half hours. The guard
works; this branch simply got there first.

The lesson is the one the workflow's own header already states, and it is worth
restating because it recurred anyway: applying a migration through the MCP is
not shipping it. It is half of shipping it. `apply_migration` returning
`{"success": true}` says the database changed, and says nothing whatever about
whether anyone will ever be able to read that change again.

## Files

| Migration                                                                                    | What it does                          |
| -------------------------------------------------------------------------------------------- | ------------------------------------- |
| `20260908025653_round_2_records_the_period_it_paid_instead_of_stamping_two_million_rows.sql` | The model change                      |
| `20260908031445_the_settlement_predicate_must_inline_or_it_is_a_per_row_call.sql`            | Drops the `SET` that blocked inlining |
| `20260908032512_the_owed_set_is_an_anti_join_not_a_set_returning_detour.sql`                 | SRF to anti-join on four hot paths    |
| `20260908033445_the_claim_records_what_it_covered_instead_of_stamping_it.sql`                | The claim stops stamping              |
| `20260908035532_the_commission_ledger_grants_no_writes_to_a_browser_role.sql`                | Table grants match the policies       |

Phase 8 of 8 remains.
