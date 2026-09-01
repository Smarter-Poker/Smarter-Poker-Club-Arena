# Say where the chips came from

Four incidents were sitting on the dashboard: three guard-definition notices and
one showing **UNCLASSIFIED FLOW TODAY 53,443,205.48**. Neither number is lost
chips, but both were real problems, and one of them was a guard that could not
be acted on.

## 1. Unclassified flow

`fn_ca_autoledger` records every watched balance change. When the caller has not
declared a counterparty it books the other side against `settlement_suspense` —
visible and gated, which is the point, but unclassified.

Measured today:

- suspense flow exists on **exactly two days**, 08-31 and 09-01. The autoledger
  triggers are that new. This is its undeclared backlog, not a leak that has
  been running.
- **81 functions / 172 function-column pairs** write a watched balance column
  and never declare. Only **two** functions on the platform had ever called
  `fn_ca_declare_ledger`.
- on a normal day (08-31) the whole flow was 334,540.96 across 2,514 rows.
  Today's 53.4M is the same paths carrying Deep Stack provisioning traffic —
  the number is large, the paths are not new.

Ranked by rows on a normal day:

| shape                                  | rows/day |
| -------------------------------------- | -------: |
| `union_wallets.rake_wallet`            |    1,021 |
| `spin_bonus_pools.balance` (both ways) |    1,251 |
| `clubs.chip_treasury`                  |       99 |
| `bbj_pools.*`                          |      102 |

### What changed

Every union wallet movement funnels through two core helpers, and both already
carry the one fact needed to classify it: `p_tx_type`. So the mapping lives
beside them:

| tx_type                 | counterparty      | category |
| ----------------------- | ----------------- | -------- |
| `rake`                  | `table_stack`     | rake     |
| `bbj_promo_sweep`       | `bbj_pool`        | promo    |
| `guarantee_overlay`     | `prize_liability` | overlay  |
| `tournament_fee_refund` | `prize_liability` | reversal |

An unmapped tx_type declares nothing and stays honestly on suspense — guessing
a counterparty would be worse than admitting one is unknown. The declaration is
set immediately before the write and cleared immediately after, so it cannot
leak onto an unrelated autoledger write later in the same transaction.

Probed rolled back first: a `rake` credit posted
`table_stack -> union_wallet category=rake`, and an unknown type stayed on
suspense.

### The ratchet

`fn_ca_undeclared_money_paths()` counts the rest. **172 pairs / 81 functions**
is recorded in its comment as the high-water mark, and the migration refuses to
apply if the number ever rises. It is **139** after this change.

Next by volume for whoever takes it: `spin_bonus_pools.balance`
(`fn_spin_activate`, `fn_spin_deactivate`, `fn_spin_reserve_seed_from_union`,
`fn_spin_absorb_club_pool_into_union`, `spin_pool_draw`), then
`clubs.chip_treasury`, then `bbj_pools`.

## 2. A guard notice you can actually review

`fn_ca_guard_defs_watch` keeps one md5 per guard. On a change it raised a notice
and, in the same breath, **overwrote the baseline** — so by the time anyone read
the notice the previous definition was gone. The incident carried an old hash
and a new hash and nothing to diff. "Review the change" was not a thing a person
could do.

It also does not self-clear despite saying so: it never re-raises for the same
change, but the notice stays open until a human resolves it. That is why three
had accumulated.

`ca_guard_def_history` now keeps every definition the watcher has seen, the
current text of all 28 watched guards is seeded as a left-hand side, and a
notice now carries the history ids of both sides with the query to diff them.

The watcher is on its own watchlist, so changing it would have raised a notice
about the change that fixes notices. Its baseline is re-set in the same
migration instead — **the habit every guard change should copy: change the guard
and re-baseline it in the same migration**, so the only notices that reach the
board are the ones nobody meant to cause.

The three open notices were resolved on the one thing that could still be
checked: all three functions still exist and still call
`fn_ca_raise_drift_incident`, so the alarms are live rather than muted. That
they could not be reviewed in detail is recorded in the resolution rather than
papered over.

## 3. One more registration

`fn_agent_wallet_self_stake` appeared today from another agent and writes
`agents.agent_wallet_balance` unregistered. Audited before registering:
authenticated, role-checked through `fn_club_bank_role`, idempotent on a
required `p_op_id` (a key reused with a different amount is refused), amount
validated to two decimals and capped, advisory-locked per actor and per club
cashier hierarchy. Registered.

## Result

**Open incidents: 4 → 0.** `no_open_incidents` passes. Unclassified-flow backlog
172 → 139 pairs and ratcheted so it cannot grow.
