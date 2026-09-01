# Phase 5 - what production says is expensive

2026-09-01. Phase 5 had no plan document naming it, so rather than guess I asked
`pg_stat_statements` what actually costs time. The answer looks nothing like the
advisor output Phases 3 and 4 worked from.

## Where the database's time actually goes

| share   | total    | calls   | mean       | what                                        |
| ------- | -------- | ------- | ---------- | ------------------------------------------- |
| **13%** | 50,739 s | 96,968  | 523 ms     | Supabase Realtime WAL decode + RLS          |
| **10%** | 38,339 s | 16,061  | 2,387 ms   | solver backfill RPC (`p_street`, `p_batch`) |
| **9%**  | 37,893 s | 252,141 | **150 ms** | `INSERT INTO hand_history`                  |
| 6%      | 24,123 s | 527,109 | 46 ms      | `SELECT ... FROM table_seats`               |
| 5%      | 20,802 s | 12,730  | 1,634 ms   | RPC (`p_table_id`, `p_club_id`)             |
| 4%      | 17,601 s | 7,353   | 2,394 ms   | `venue_daily_tournaments` SELECT            |

Fourteen hours of database time in first place, and none of it appears in any lint.

## Fixed here: the settlement dashboard's realtime firehose

`agent_commissions` is a **per-hand** commission ledger. Measured:

- 1,539,684 rows since 2026-05-01, averaging **0.40 chips** each
- 1,878,396 lifetime writes - **the highest of any table in the
  `supabase_realtime` publication** (113 tables)

`SettlementDashboardPage` subscribed to **every INSERT on it, platform-wide, with
no filter**, and called `loadData()` directly - a full dashboard reload - per row.

The tell is in the same file. The six `masterBus` subscriptions immediately above
it are every one of them debounced:

```ts
masterBus.subscribeDebounced('SETTLEMENT_CYCLE_COMPLETED', () => loadData(), 500);
masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadData(), 2000);
masterBus.subscribeDebounced('TRANSACTION_LOGGED', () => loadData(), 2000);
```

and then, twenty lines later:

```ts
{ event: 'INSERT', schema: 'public', table: 'agent_commissions' },
() => loadData()
```

Debounced at 2000 ms, matching `BALANCE_UPDATED` and `TRANSACTION_LOGGED`, which
carry the same kind of money-movement news. The timer is cleared on unmount so it
cannot fire into a dead component.

**Being accurate about the severity**, because overstating it would be the third
time today I reached for a dramatic number: `loadData()` opens with
`if (loadingRef.current) return;`, so overlapping reloads were already dropped.
This was never 1.8 million client reloads. It re-armed a full reload on every
commission row, and a settlement dashboard does not need per-hand granularity to
be correct. The server-side cost - Realtime decoding and RLS-checking every one of
those records - is the larger half, and is not fixed by this change (see below).

Pinned by `tests/unit/realtimeFirehoseIsDebounced.law.test.ts`, verified
red-before-green by reintroducing the exact `() => loadData()` handler and watching
the pin fail.

## Not fixed here, and it needs Dan

The 13% is dominated by Realtime decoding `agent_commissions` at 1.88M writes.
**Debouncing the client does not reduce that** - Realtime decodes and RLS-checks
every record in the publication regardless of who is listening. The levers are:

1. **Remove `agent_commissions` from the `supabase_realtime` publication.**
   Cheapest by far, but four subscriptions depend on it (`AgentPortalPage`,
   `SettlementPage`, `SettlementDashboardPage`, `AgentRakeService`) and they would
   silently stop updating live. That is a product decision about whether agents
   need per-hand commission updates in real time.
2. **Roll the ledger up.** 0.40 chips per row for 1.5M rows is a lot of rows to
   carry for the amount of money described. This is a money-path change and is not
   an agent's call.

Both are recorded rather than done.

## Also worth someone's attention

`INSERT INTO hand_history` costs **150 ms** and is 9% of all database time. The
table carries 10 indexes (1,260 MB) and **6 triggers** on the dealing hot path:
`hand_history_club_member_stats`, `hand_history_fold_stats`,
`hand_history_position_stats`, `trg_ca_capture_hand_facts`,
`trg_enqueue_hand_daily_missions`, `trg_log_jackpot_hand_deleted`. Five of those
are synchronous stats derivation. `table_seats` carries 11 indexes and **12
triggers**. Neither was touched here; both are the obvious next target.
