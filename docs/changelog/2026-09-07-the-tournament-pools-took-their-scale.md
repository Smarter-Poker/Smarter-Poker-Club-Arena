# 2026-09-07 - The tournament pools took their scale, and what the freeze is actually like

`20260906162705` is the other half of phase 3: `tournaments.prize_pool`,
`.bounty_pool` and `.total_rake` to `numeric(18,2)`. It had to run inside the
:55 maintenance freeze because a rewrite of a 147 MB table every seat and
finish writes cannot be slipped in beside live play - the first attempt, at
16:25, deadlocked on `AccessExclusiveLock on relation tournaments`.

**Applied 2026-09-06 23:59:25, inside the freeze**, with its own assertion
passing: `CHIP_SCALE_TWO_COMPLETE all ten formerly-unconstrained money columns
carry scale 2`. Phase 3 is closed - the repo and the database agree again.

Two things the freeze taught, both found by running it, and both now written
into the migration's header:

## 1. The freeze is not the same thing as an idle table

Four consecutive attempts died on `55P03 canceling statement due to lock
timeout` while `fn_platform_frozen()` was true the whole time. The holder was
not live play: **pg_cron pid 1035737, `tourney-payout-sweep-hourly`**, 244
seconds into a `statement_timeout = 300s`, holding RowShare and AccessShare on
`tournaments`. pg_cron does not stop for the freeze - CLAUDE.md 13 says as much
and this is the cost of it. The sweep starts around :51 and can run to :56, so
the ACCESS EXCLUSIVE window inside a five-minute freeze is realistically **:57
to :00**. A retry loop that waits it out lands; widening `lock_timeout` would
only mean queueing behind it, which is what the short timeout exists to
prevent.

## 2. A view owns a copy of the column type

Once the lock was granted at 23:57:13 the real error arrived: `0A000 cannot
alter type of a column used by a view or rule`.
`public.tournament_escrow_shadow` selects all three columns.

So the view stands aside and comes back exactly as it was, by the rule
`20260906162156` used for the union auto-ledger trigger: its definition,
options, comment and grants are READ FROM THE CATALOGUE and re-issued, never
retyped, and the migration compares the restored definition against the
captured one character for character before it commits. It is the escrow
shadow - the report phase 2 used to tell a stale counter from a real gap - so
losing or altering it silently would blind exactly the check that finds money
problems.
