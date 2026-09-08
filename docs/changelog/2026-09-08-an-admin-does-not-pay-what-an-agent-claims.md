# An admin does not pay what an agent claims

2026-09-08. Closing a defect carried through phases 7 and 8: the "pay" button
on `AdminDashboardPage`'s settlements tab. Branch
`fix/an-admin-does-not-pay-what-an-agent-claims`.

## What it did

Two controls: **Mark Paid** on a commission row, and **Mark All As Paid** on
the period. Both ran a `DELETE` against `agent_commissions` from the browser,
with this comment above them:

> `agent_commissions has no 'status' column - delete to acknowledge payment`

Three faults, in increasing order of seriousness.

**1. It never ran.** RLS on `agent_commissions` grants writes to `service_role`
alone; `authenticated` has `agent_reads_own_commissions` and
`union_overseer_read`, both SELECT. A `DELETE` from a browser therefore matched
zero rows — and a PostgREST delete that matches nothing is not an error. The
operator got the success path every time. `n_tup_del` on that table is **1,
ever**, against 3.97M rows.

**2. Deleting a ledger row is not a payment.** It destroys the record of what
was owed instead of recording that it was settled. Had it worked, `pay_all`
would have erased _every_ commission row in the club for the period — the
evidence, not the debt. Since phase 8 the append-only guard refuses the DELETE
outright, so the button had gone from silently doing nothing to loudly failing.

**3. An admin does not pay an agent's commission at all.** The platform's real
path is `fn_agent_claim_commission`, and it deliberately takes **no
`p_user_id`** — its own comment says why:

> a parameter naming somebody else would make this a way to move another
> person's earnings, and Dan's rule is that agents handle their own payouts.

It debits the club bank, credits the agent's own wallet, stamps `settled_at`,
writes `agent_commission_settlements` and a `chip_transactions` row, is
idempotent on an `op_id`, and refuses when the bank is short. Everything the
button pretended to be, already built.

So this screen was offering an action the platform does not have, implemented
by destroying the ledger, and reporting success for a write that never
happened. **A control that reports success without doing anything is worse than
no control, because it stops anybody looking.**

## What it does now

The tab is read-only against `agent_commissions`, and says three true things:

- **`settled_at` per row** — `Claimed` or `Awaiting Claim`. That is the column
  the claim actually stamps, and the only one phase 8's guard lets move
  (`NULL` -> a time, once).
- **What is still unclaimed this period**, counting only rows with no
  `settled_at`.
- **The club bank against it.** An agent's claim is refused when
  `chip_treasury` cannot cover it, and funding the bank is the one part of this
  an operator controls — so when it is short the screen says so in the same
  words the claim returns: _Fund The Bank So Their Claims Go Through._

## Pinned

`tests/an-admin-does-not-pay-what-an-agent-claims.law.test.ts`, 8 pins: no
delete against the ledger, no `pay` / `pay_all` action, no button claiming to
mark a commission paid, every `agent_commissions` call is a `select`, and the
replacement reads `settled_at` and the treasury. Comments are stripped before
matching, so prose describing the removed bug can neither satisfy nor defeat a
pin.

## Found while here, not changed

`useArenaStore.loadStats` calls `get_user_level_stats(p_user_id)` and reads
`{total_clubs, active_tables, active_players, ...}` from it. That function is a
stub returning hard-coded `{xp, level, xp_to_next, progress_pct}`, so every
field the store reads is `undefined`. **The action has no caller** —
`useArenaStore` is used by `MasterBus` for `getState()` and `reset()` only, and
`loadStats` is never invoked — so it moves no money and breaks no page. Named
here rather than deleted, together with the World Hub audit note of the same
date that fixes the _other_ caller of that same function.
