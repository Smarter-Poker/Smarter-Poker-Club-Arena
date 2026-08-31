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

## Still open

`ca_seat_stack_exits` records **1,736 cash-table seat rows a day ending by
`DELETE`**, carrying ~649k chips, against CLAUDE.md section 11.5's rule that a
seat must never end that way. Nothing is being lost today - the deleting path
refunds first, which is why this alarm reads 0 - but the guarantee rests on
convention rather than on anything enforcing it. That is the next piece of
phase 4, and it is a separate change.
