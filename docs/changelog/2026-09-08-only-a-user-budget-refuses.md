# Ruling 21: a platform budget never refuses a player. Only a user budget does

2026-09-08. `supabase/migrations/20260908130203_only_a_user_budget_refuses.sql`.

Dan, verbatim: **"THERE SHOULDN'T BE A PLATFORM BUDGET ON THINGS LIKE THIS, ONLY
A USER BUDGET."**

A per-user cap is a rule about one player and their own earning. A platform-wide
monthly pot is a rule about everybody else's: it is a shared pool, so whoever
arrives early spends it and whoever arrives late is refused for something they
did nothing to deserve. That is not a cap, it is a race, and the player cannot
see the clock.

## Two pots could refuse. Both stop

### 1. The per-engine monthly pot

`fn_ca_diamond_earn_ledger` read `diamond_reward_budgets` and
`DR7:engine_over_budget` was scheduled to flip from `log` to `refuse` on
**2026-09-14**. With the spend counter repaired that morning, `daily_missions`
reads **127,305 against a 30,000 line** - 4.2 times over - so the flip would have
refused every daily-mission award for the rest of September.

The block is gone from the award path entirely: no read, no refusal, and **no
incident per award** either. At 4.2x an incident would have fired on every single
award and been muted inside a day, which is the always-on alarm this estate
already learned about (10.84). The rule row is deleted rather than left at `log`,
because a rule nothing consults reads as armed while being unreachable (10.86).

### 2. The platform-wide monthly pot

`award_diamonds_v2` read `diamond_platform_budget ... FOR UPDATE` and refused
with `budget_exhausted` when the shared pot was dry. It was doing something worse
as well:

```sql
v_award := LEAST(v_award::bigint, v_budget_left)::int;
```

a **silent truncation**. A player owed 100 who arrived when the pot held 7 was
paid 7, flagged `capped: true`, with no way to learn that the number had nothing
to do with anything they had done. It had not bitten yet - 1,210 spent of
2,500,000 this month - which is exactly why it was worth removing before it did.

The refusal, the truncation and the hot-row `UPDATE` that fed them are all gone.
That last one also removes a second contention point of the same shape as the one
that lost 5,860 awards to lock timeouts this morning.

## What remains, and is now the whole of the control

- `diamond_engine_daily_caps`, per user per engine per day: daily_challenges
  2,000, daily_missions 500, trivia 2,000, wheel 10,000, referrals 1,500,
  catalog_v2 110, club_arena_daily 110. **`DR7:user_over_daily_cap` still flips
  to refuse on 2026-09-14**, unchanged.
- `award_diamonds_v2`'s per-user daily allowance and per-user monthly allowance
  (4,500 VIP / 3,300 otherwise) - a monthly limit on one player is a user budget.

Both `budget_diamonds` columns keep being written and read by the economy report,
and both carry a comment saying they are a forecast and not a gate, so nobody
re-arms them by reading the name.

## Proved before it was applied

A rolled-back probe emptied the shared platform pot to zero - the exact condition
that returned `budget_exhausted` under the old code - and then made a real award
through `award_diamonds_v2`. It paid **in full, `capped: false`**.

After applying, on production: the earn ledger no longer mentions the engine pot,
`award_diamonds_v2` no longer contains `budget_exhausted` or any reference to
`diamond_platform_budget`, `DR7:engine_over_budget` is gone from the rule table,
all seven per-user daily caps are intact, the per-user monthly allowance is
intact, `DR7:user_over_daily_cap` is still scheduled for the 14th, identity
`0.00`, zero unreachable money paths, zero open critical incidents.

## A note on how the assertions were written

Two of them failed on the first run against the migration's own explanation: the
new bodies name `DR7:engine_over_budget` and `budget_exhausted` in comments that
describe what they no longer do. The checks strip comments before looking, for
the same reason `fn_ca_diamond_unreachable_money` was corrected this morning - a
mention is not a call.
