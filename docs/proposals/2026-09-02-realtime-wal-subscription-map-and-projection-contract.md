# Realtime WAL: the subscription map, and why the projection should not be built for `agent_commissions`

Status: **FOR DECISION. No code or money-path change made.**
Requested by Dan: _"Return with the subscription map and proposed projection
contract before changing the money path."_ This is that return, and it carries a
correction: **the premise I gave for prioritising `agent_commissions` was wrong.**

---

## 1. The subscription map, as asked

Four callsites subscribe to `agent_commissions`. All four are **INSERT-only**, and
**not one of them reads the payload**:

| #   | Callsite                                    | Event  | Server-side filter                           | Handler                                    | Payload fields used |
| --- | ------------------------------------------- | ------ | -------------------------------------------- | ------------------------------------------ | ------------------- |
| 1   | `src/pages/AgentPortalPage.tsx:104`         | INSERT | `user_id=eq.<self>`                          | `loadCommissionHistory()`                  | **none**            |
| 2   | `src/pages/SettlementDashboardPage.tsx:345` | INSERT | _none_                                       | `loadData()`, debounced 2000ms since #2473 | **none**            |
| 3   | `src/pages/SettlementPage.tsx:535`          | INSERT | `club_id=eq.<club>` when resolved, else none | `masterBus.emit('BALANCE_UPDATED')`        | **none**            |
| 4   | `src/services/AgentRakeService.ts:162`      | INSERT | `club_id=eq.<club>` when passed, else none   | `onChange()` callback                      | **none**            |

**The contract these four actually need is a notification, not a row:** _"commission
rows changed in this scope"_, where scope is a `user_id` or a `club_id`. Every one
of them responds by re-reading through its normal authorised query path.

That is the strongest possible case for a projection - the clients want an event,
not data - and it is why the projection idea is sound in principle.

There is an irony worth recording. `AgentRakeService` explains in its own comment
that `rake_records` is deliberately **not** published because it _"would broadcast
every hand on the platform to every subscriber, which is both a firehose and a
cross-club data leak"_ - and then subscribes to `agent_commissions`, which is
written per hand and **is** published, for exactly that signal. Subscription 2
carries no filter at all, so before #2473 it received every commission row on the
platform.

---

## 2. The measurement, which changes the priority

I previously reported that the 13% Realtime decode was _"dominated by
`agent_commissions`"_. **That was wrong, and I withdraw it.** It came from
comparing a LIFETIME write counter against other tables' counters at a moment when
this table's counters happened to be the oldest. `pg_stat` counters were reset
platform-wide part-way through the day, which flipped the ranking and exposed the
error.

Measured properly over a clean **4h55m interval** (19:56:06Z -> 00:51:46Z), taking
two snapshots and differencing:

| table                    | writes in window | share of publication writes | columns | avg row bytes | est. bytes decoded |
| ------------------------ | ---------------: | --------------------------: | ------: | ------------: | -----------------: |
| `tournaments`            |          207,245 |                       22.4% | **106** |     **1,761** |        **~365 MB** |
| `table_hole_cards`       |          204,770 |                       22.1% |       7 |           518 |            ~106 MB |
| `table_seats`            |          204,215 |                       22.1% |      22 |           166 |             ~34 MB |
| `tables`                 |          129,700 |                       14.0% | **145** |           565 |             ~73 MB |
| `tournament_players`     |           81,157 |                        8.8% |      25 |           254 |             ~21 MB |
| `game_management_events` |           42,069 |                        4.6% |      14 |           230 |             ~10 MB |
| `chip_transactions`      |           12,475 |                        1.3% |       - |             - |                  - |
| **`agent_commissions`**  |       **11,693** |                   **1.26%** |      10 |           260 |          **~3 MB** |

`agent_commissions` is **1.26% of publication write events and roughly 0.5% of the
bytes decoded**. Even a perfect projection - zero events instead of 11,693 - would
remove about **0.16% of total database time**, not 13%.

That is not worth a change on the money path.

### Where the 13% actually is

`tournaments` alone is ~60% of the decoded bytes: **106 columns, 1,761 bytes per
row, updated 207,245 times in five hours** on a table of 58,417 rows. `tables` is
145 columns wide. Both are UPDATE-churned by the engine, and because replica
identity is `DEFAULT`, **the entire new tuple is decoded and RLS-checked on every
update**, however few columns actually changed.

The publication config is the other half of it:

```
supabase_realtime: 114 tables
  pubinsert=true  pubupdate=true  pubdelete=true  pubtruncate=true
  row filters: 0        column lists: 0
```

Everything, for every table, with no narrowing of any kind.

---

## 3. What I propose instead

**Dan's instruction was right; the target was wrong.** _"Replace them with a
narrower read/projection surface that publishes only the fields and events the
clients require"_ is achievable directly at the publication, on the tables that
actually carry the volume, and **without touching a ledger at all**.

Postgres 15+ (this database is 17.6) supports per-table **column lists** and **row
filters** in a publication. Applied to `tournaments` and `tables`, they cut what
Realtime decodes, RLS-checks and transmits, without altering a single write path.

### Proposed sequence

1. **Establish the consumer contract per table.** For `tournaments`, enumerate
   every field any subscriber reads from `payload.new`. Most consumers ignore the
   payload and just call `load()`, but `TournamentHUD.tsx:212` does
   `setTournament(prev => ({ ...prev, ...payload.new }))` - it merges the whole
   row - so the column list must be a superset of what that component renders,
   plus `id` and any filter keys.
2. **Ship behind a flag**, as instructed: apply the column list to a staging
   publication first, or gate the HUD on a feature flag that falls back to a
   full re-read.
3. **Reconcile**: assert that the fields the HUD renders are identical with and
   without the column list, over a full tournament lifecycle.
4. **Measure** the same way this document did - two `pg_stat` snapshots over a
   fixed interval, plus `pg_stat_statements` on the Realtime decode statement -
   and only then widen to `tables`.

### What I recommend for `agent_commissions`

**Leave it exactly as it is.** It is 1.26% of the volume, the debounce from #2473
already removed the client-side reload storm, and the remaining cost does not
justify a change to a financial ledger's publication surface. Revisit only if its
write rate rises materially - it is bursty (78,470 rows on 08-31 versus 32,759 on
08-30), so it is worth re-measuring rather than assuming.

If you still want the notification-only surface for its own sake - it is the
cleaner design, and the map above shows the clients need nothing else - it should
be justified as an architecture change, not as a performance one.

---

## 4. What I have not done

No projection table. No publication change. No ledger change. No subscription
retired. This document exists so the decision is made on measured numbers rather
than on the incorrect attribution I supplied earlier.
