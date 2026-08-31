# 2026-08-31 - The alarm that proves no chips vanished had stopped finishing

## What was wrong

`fn_unaccounted_seat_exits()` is the only thing on this platform that can say a
seat left the felt carrying a non-zero stack and no wallet credit ever landed.
`reconcile_ledger_nightly` files every row it returns as CRITICAL.

Called at its own 7-day default it **exceeded 60 seconds and was cancelled**.
Only a hand-narrowed 24-hour window still completed.

An alarm that times out does not report zero. It reports nothing, and from the
outside nothing looks exactly like zero.

## Where the time went - measured, not guessed

Both obvious suspects are innocent. `EXPLAIN ANALYZE` over six hours:

```
Nested Loop Anti Join ... Execution Time: 120.543 ms
  Index Scan using idx_wallet_transactions_user_created
    (actual time=0.043..0.043 rows=1 loops=819)
```

and the same anti-join over the full seven days returns in seconds (1,037 rows).

The cost is the third clause, the one that forgives an exit already repaid by
hand:

```sql
AND NOT EXISTS (SELECT 1 FROM wallet_transactions wt
  WHERE wt.user_id = e.user_id AND wt.type = 'credit'
    AND wt.description ILIKE 'Correction: seat exit ' || e.id || '%')
```

`ILIKE` against a concatenation is unindexable, so that is a **sequential scan
of 2,480,976 rows, run once per surviving exit** - and there are 1,037 of them.
Only **1,040** rows in that table match the prefix at all. The scan throws away
2.48 million rows a thousand times over to find them.

Now the correction rows are collected ONCE in a `MATERIALIZED` cte and
anti-joined on a parsed exit id.

## CORRECTION (added the same day, on audit): which caller was actually broken

The text above says the alarm "had stopped finishing" without saying for whom,
and that reads as though the scheduled reconciliation was failing nightly. It
was not, and the distinction matters to anyone deciding how urgent this was.

Checked afterwards, against the live database:

```
reconcile_ledger_nightly   calls fn_unaccounted_seat_exits('1 day'::interval)
fn_chip_integrity_report   calls fn_unaccounted_seat_exits()        <- the default
```

So the **6-hourly reconciliation job was never affected** - its 1-day window
always completed, and it has been filing `seat_stack_exit` rows correctly the
whole time. The caller that hit the timeout is `fn_chip_integrity_report()`,
which takes the 7-day default, and the World Hub admin ledger surface
(`pages/api/horses/club-arena-admin.js`) which calls the RPC with both arguments
defaulted. Those are the surfaces a human looks at when they want to know
whether chips have gone missing, and they were the ones timing out.

Still worth fixing, for exactly that reason. But "the nightly alarm was down"
would have been wrong, so it is corrected here rather than left to mislead the
next reader.

## A latent wrong answer went with it

`ILIKE 'Correction: seat exit ' || e.id || '%'` is a **prefix match on a
number**. A correction written for exit **51** also matches exit **5** - so exit
5 would be forgiven a repayment it never received, and the alarm would silently
clear a real loss. Checked: 0 prefix collisions among the 1,040 correction ids
today. It is one busy day away. Parsing the id with a bounded regex cannot make
that mistake.

## Equivalence, checked against production before the migration was written

```
candidates (7d, cash tables, no matching credit)   1037
of those, matched to a hand-written correction     1037
unaccounted after the correction clause               0
prefix collisions among correction ids                0
```

Identical to what the old body returns over the windows where the old body can
still be made to finish.

## Applied and verified

Migration `20260831142004 the_alarm_that_proves_no_chips_vanished_must_finish`,
applied via the Supabase MCP.

**Both files are named for the version they were actually applied under.** The
first draft named this one `20260831_...`, which collided with 28 other
`20260831_` files and was caught by
`scripts/ci/check-new-migration-version-collisions.mjs` - correctly. Naming a
migration file for its applied version is not cosmetic here: the repo copies are
history rather than truth (see `check-migrations-applied.mjs`), so the version
stamp is the only thing tying a file to the statement that actually ran.

Its post-apply block asserts BOTH halves and would have rolled the whole thing
back on either: that the 7-day default returns inside 30s, that the 7-day window
never reports FEWER unaccounted exits than the 24-hour one, that
`fn_wallet_claim_back` still exists, and that `service_role` still holds EXECUTE
so `reconcile_ledger_nightly` can still call it.

Measured after apply:

```
7-day default   0 rows in 8,503 ms      (was: cancelled at 60s)
```

The file in this repo is **byte-identical to the function running in
production** - `md5(prosrc) = 96f69ec47495684dd5dd42315155c999`, matched against
the committed body.

## And the guard found something while it was looking

`scripts/ci/check-definer-authorization.mjs` blocked the push the moment the
migration re-declared the function - and it was right about something that
**pre-dates this work**:

```
fn_unaccounted_seat_exits
  SECURITY DEFINER, anon can execute it, and it never calls auth.uid(),
  auth.role() or auth.jwt(). It runs as the owner, past RLS, for a caller
  with no account - and it never asks who that caller is.
```

Grants were `postgres, authenticated, service_role` plus PUBLIC. Any signed-in
player could ask it for **every seat exit on the platform** - `user_id`,
`club_id`, `table_id` and the exact stack that walked off each seat. A
per-player chip-movement feed for the whole estate. Read-only is not the same as
harmless.

Nothing in either repo calls it from a browser; its one real caller is
`reconcile_ledger_nightly`, running as postgres/service_role. Closed in
`20260831142652_the_seat_exit_alarm_is_not_a_browser_api.sql`, verified live:

```
anon_can  false      auth_can  false      svc_can  true
```

`fn_club_chip_circulation()` is the neighbouring function of the same kind and
was deliberately NOT swept along with it - a different decision on a different
function deserves its own migration.

## The seat-DELETE question, chased down and CLOSED

The first draft of this file said 1,736 cash-table seat rows a day were still
ending by `DELETE` against CLAUDE.md section 11.5. That number was a 24-hour
average, and chasing the deleting path showed the average was hiding the answer.

Neither known deleter touches a live seat. `HydraService.seatHorse` and
`atomic_table_buyin` both delete only rows with `left_at IS NOT NULL`, and
`fn_log_seat_stack_exit` already returns early on those - so every
`exit_kind = 'deleted'` row is a LIVE seat destroyed, which is the real thing
section 11.5 forbids.

Per hour, it stops dead:

```
2026-08-31 06:00Z   deleted 170
2026-08-31 07:00Z   deleted   0
2026-08-31 08:00Z   deleted 149     <- last one
2026-08-31 09:00Z   deleted   0
... through 14:00Z  deleted   0     six clean hours
```

**#2038 - "a seat never ends by DELETE: locked cash-out on boot, remove_horse
retired, bomb ledger repaired" - merged at 08:45:21 UTC today.** The last delete
falls inside the hour it landed; there has not been one since. `GameServer.ts`
now carries the cash-out-then-vacate path and
`server/src/seatExitMoneyPaths.test.ts` pins `never issues a table_seats
DELETE`.

The bursty shape was the tell all along - 0 for hours, then 100-300 in one hour

- because the old path swept seats at BOOT, so it fired once per engine restart
  rather than continuously.

Nothing to fix here. Recorded because the earlier reading was wrong and the
correction is the useful part.
