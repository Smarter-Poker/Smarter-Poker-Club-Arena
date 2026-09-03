# 2026-09-03 - chip standard, Phase 2 lane 2.2: commission accrues for every agent in the chain, per hand

Branch `fix/chip-std-p2-commission-per-agent`. Migration
`supabase/migrations/20260903163422_commission_accrues_for_every_agent_in_the_chain.sql`,
applied to production ONCE at 16:34:22 UTC via the MCP apply (recorded as
version `20260903163422`, name `commission_accrues_for_every_agent_in_the_chain`);
the repo file is the byte-exact export of the recorded body plus one trailing
newline. Its self-check DO block ran green. One `CREATE OR REPLACE FUNCTION`,
no table, no index, no trigger, no backfill, no chips moved. The live
`prosrc` after apply is md5 `1583ac138b7687091e7c5a049f0639e9` (3,670 bytes);
the repo body hashes the same.

Audit: `docs/audits/2026-09-02-chip-standard-round2/lane2-hierarchy.md`
route C4, finding F2 (High). Standard principles P4 (rake is attributed at
source, every agent in the chain of every contributing player) and P14
(horses are players).

## What was wrong

`credit_agent_commission_from_rake(p_agent_user_id, p_club_id, p_rake_credit,
p_source_type, p_source_id, p_notes)` is the only live cash-hand accrual path
(engine `RakebackSettlerService` -> `fn_credit_agent_commissions_batch` ->
this function, once per contributing player of a hand, `source_id` = the hand
id, `source_type` = `rake_settlement`; the same function serves
`tournament_fee` rows and `fn_attribute_tournament_rake`). It opened with

```
IF p_source_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM agent_commissions
   WHERE source_id = p_source_id AND source_type = p_source_type LIMIT 1
) THEN RETURN; END IF;
```

No `user_id`. The first contributor's agent and that agent's super-agent
override were booked; every later contributor's call returned before the
agent was even looked up. `calculate_cascading_commission` is the only other
writer of `agent_commissions` and it is dormant (0 rows of `source_type =
'rake'` in 30 days), so no other path books the same agent for the same
source: the fix cannot double-book.

## Measured (production, SELECT only, 2026-09-03 ~16:10 UTC)

Last 24h of `agent_commissions`, rows vs distinct sources:

| source_type                  | kind        | rows   | distinct sources | amount    |
| ---------------------------- | ----------- | ------ | ---------------- | --------- |
| `rake_settlement`            | direct      | 93,536 | 93,536           | 23,112.49 |
| `rake_settlement`            | super-agent | 86,583 | 86,583           | 19,722.46 |
| `tournament_fee`             | direct      | 5,698  | 5,698            | 3,488.49  |
| `tournament_fee`             | super-agent | 4,767  | 4,767            | 3,187.15  |
| `tournament_rake_settlement` | direct      | 37,860 | 37,860           | 19,856.76 |
| `tournament_rake_settlement` | super-agent | 32,316 | 32,316           | 18,371.18 |

Exactly one direct agent per source, always. The settler lags the hand by
about three hours (rake at 13:11, booked at 16:07).

Raked cash hands in the 24h window ending four hours before the reading:
102,274 hands, 189,791.80 rake. Of the (hand, agent) pairs among contributors
with an agent in the table's club: 263,809 pairs over 80,637 hands; 79,852
hands had more than one agent; 13,489 pairs had two or more contributing
players under the same agent.

Concrete hand `134a1847-1e96-41c0-a6a2-8c865d155790` (club `2a1132b9`, rake
8.00, WEIGHTED_CONTRIBUTED, six seated, two contributors at 131 each = 4.00
share each):

| contributor | agent (rate, role)         | parent (rate, role)          | booked before              |
| ----------- | -------------------------- | ---------------------------- | -------------------------- |
| 1545d652    | a477eee0 (0.25, sub_agent) | 5c3c64a2 (0.55, agent)       | 1.00 direct, 1.65 override |
| f9e96cd6    | 0362d601 (0.50, agent)     | a9ff80c3 (0.70, super_agent) | nothing                    |

Four agents in the chains of the hand, two booked.

## What changed

The guard moved below the two-step agent lookup and gained
`AND user_id = v_agent_user_id`. Nothing else: reconstructing the old body
from the new one by moving the guard back hashes to the live pre-apply
`prosrc` (md5 `cc8e0b5ee81b9c5c927e78d825e2663f`, 3,406 bytes), so the union
law resolution, `ROUND(.., 2)`, both `ON CONFLICT (user_id, source_id,
source_type) WHERE source_id IS NOT NULL DO NOTHING` clauses, the
`ROW_COUNT`-gated accumulator bump and the super-agent override are
byte-identical. Grants unchanged (service_role EXECUTE; anon and
authenticated none; not SECURITY DEFINER). The unique index
`uq_agent_commissions_source (user_id, source_id, source_type) WHERE source_id
IS NOT NULL` already existed; the self-check asserts its exact definition.

## Rolled-back probes

Before apply (old body), inside `BEGIN ... ROLLBACK`: calling the accrual for
the second contributor of hand 134a1847 with share 4.00:

```
probe                              rows_after  rows
OLD body: second contributor call  2           a477eee0:1.00, 5c3c64a2:1.65
```

After apply (new body), inside `BEGIN ... ROLLBACK`, replaying contributor 1,
then contributor 2, then contributor 2 again:

```
step                                              rows  detail
0 before                                          2     a477eee0:1.00 @0.2500, 5c3c64a2:1.65 @0.5500
1 after replay of contributor 1 (already booked)  2
2 after contributor 2 (NEW body)                  4     a477eee0:1.00 @0.2500, 5c3c64a2:1.65 @0.5500,
                                                        a9ff80c3:1.40 @0.7000, 0362d601:2.00 @0.5000
3 after contributor 2 called again                4
4 agents accumulator touched                      1     0362d601 (the newly booked direct agent only)
```

4.00 x 0.50 = 2.00 to the agent; (4.00 - 2.00) x 0.70 = 1.40 to the super
agent. A replay writes nothing and bumps nothing. All of it rolled back.

## Verified in production after apply

See the numbers appended at the bottom of this file (rows per source for
`rake_settlement` sources booked after 16:34:22 UTC).

## What this books from now on (estimate, numbers only)

Model: per contributor, share = rake x contribution / sum(contributions),
direct = round(share x rate, 2), override = round((share - direct) x
parent_rate, 2), one row per (hand, agent) as the key allows. On the 6h
sample the model reproduces the booked direct rows within 0.16% (7,256 of
7,628 rows exact, 2,002.66 booked vs 1,999.48 modelled).

On the 68,193 hands of the 24h window whose contributors have an agent in
the table's club:

| leg         | expected rows | expected amount | booked rows | booked amount | unbooked per day |
| ----------- | ------------- | --------------- | ----------- | ------------- | ---------------- |
| direct      | 219,851       | 53,332.21       | 63,843      | 16,827.98     | 36,504.23        |
| super-agent | 177,218       | 38,236.62       | 59,884      | 14,128.87     | 24,107.75        |
| total       | 397,069       | 91,568.83       | 123,727     | 30,956.85     | 60,611.98        |

So roughly 60,600 chips of commission per day were going unbooked on the
hands the model covers (about 3.4x the direct rows, 3.0x the amount). The
model does not cover hands whose contributors sit under an agent in a
different union club (the live function resolves that through
`fn_resolve_player_club_for_agent`); scaling by the booked totals on all
hands (42,300.03) versus covered hands (30,956.85) puts the full figure near
83,000 chips per day. Both are estimates of an obligation, not credits; no
backfill was run (roadmap: backfill nothing).

## Known residual, reported not built

Two contributing players under the SAME agent at one hand still produce one
row for that agent: the second share is dropped by the (user_id, source_id,
source_type) key. 13,489 of 263,809 pairs in 24h (5.1%). Fixing it needs a
different idempotency key (for example the contributing player in the key)
and therefore a new unique index on `agent_commissions` (1.6M+ rows), which
cannot be built CONCURRENTLY inside the migration transaction and would lock
a hot table if built plainly. That is a separate lane with its own index
plan; it is not in this change.

Also unchanged and out of lane: F13 (the fallback agent lookup is still
unscoped to the booking club) and F6/F7 (two payers for commission and
rakeback).
