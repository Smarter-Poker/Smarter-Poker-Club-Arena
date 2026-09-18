# The settlement read finds its hand (2026-09-18)

One index. Migration `20260918002945`, applied 00:33:12 UTC and recorded.

## What happened

`public.ca_settlements` holds 7,894,851 rows in 6,657 MB, of which 7,783,150 are `hand_stacks`/`final`. Its indexes were the primary key, `(settlement_type, external_ref)` and two on `updated_at`. Nothing indexed the table or the hand.

Every dealt cash hand calls `fn_cash_accept_hand_provenance`, which reads exactly one row:

```sql
SELECT to_jsonb(c) FROM public.ca_settlements c
 WHERE c.table_id = p_table AND c.hand_id = v_stack_hand
   AND c.settlement_type = 'hand_stacks' AND c.state = 'final'
```

`fn_pnl_cash_hand_evidence` reads it the same way. With no index the planner had one option. Measured on production at 00:33 UTC, before the change:

```
Gather (actual time=7511..9670 rows=0)
  Workers Planned: 4, Launched: 4
  Buffers: shared hit=484321
  ->  Parallel Seq Scan on ca_settlements c (actual time=7387 rows=0, loops=5)
```

9.7 seconds, five backends, 3.8 GB of shared buffers, to find at most one row — about 250 times a minute, against an eight-second statement timeout that cancelled the very reads causing the load.

## What it cost

| Window              | Statement timeouts a minute         | Hands dealt a minute |
| ------------------- | ----------------------------------- | -------------------- |
| 22:10-23:30         | single digits                       | 555-719              |
| 23:40               | rising                              | 42                   |
| 23:50               | rising                              | 5                    |
| 00:00-00:32         | 195-472, 96% of them this one query | 34-97                |
| 00:33 (index built) | 7                                   | —                    |
| 00:34 onward        | 2, then 1, none from ca_settlements | 550, then 845        |

At 00:20:04 the engine began reporting `supabase_timeout` on unrelated paths, tournament leases expired, watchdogs self-terminated their engines, and the fleet fell from 1,478 active tables and 2,326 seated horses to 230 and 274 in six minutes. It recovered to 1,582 tables and 2,734 horses within two minutes of the index, with no restart and no code change.

## The change

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ca_settlements_table_hand
  ON public.ca_settlements (table_id, hand_id);
```

`settlement_type` and `state` are deliberately not in it: 98.6 percent of the table is `hand_stacks`/`final`, so they add nothing to selectivity. CONCURRENTLY, and therefore no transaction wrapper, because the table takes a write on every settled hand; the build took two minutes.

After: the same query is `Index Scan using idx_ca_settlements_table_hand`, 7.7 ms, 10 buffers. A thousand-fold on time and forty-eight thousand-fold on buffers.

## What this says about the ones like it

The same shape is worth looking for elsewhere. `pg_stat_user_tables` on the same morning: `tournament_payouts` had been read sequentially 99.9 billion times over 502,793 scans, and `bbj_contributions` 24.9 billion over 19,404. Neither is as hot per call as this was and neither is currently timing out, but both are the same question — a big table read by a predicate no index serves — and they belong on the performance list rather than in a night's firefight.
