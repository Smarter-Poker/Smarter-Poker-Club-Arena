# The Spins audit, end to end — and the rake that reached nobody

2026-08-31. Dan: _"DO A FULL AUDIT OF THE SPINS FUNCTIONALITY FROM START TO
FINISH, FROM SITTING DOWN, BUYING IN, WAITING FOR 3 PLAYERS, SPIN ANIMATION
STARTS, TOURNAMENT FLOW, BLINDS INCREASE, PAYOUTS EVERYTHING, AND YOU NEED TO
VERIFY IT ALL DOING A LIVE E2E TEST."_

Everything below was measured against production, not read out of source. Where
something is asserted, the query or the browser measurement that produced it is
named.

## 1. What the audit verified, and what it cost to verify

| Stage                     | How it was verified                                                        | Result                                                                               |
| ------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Sit down + buy in         | 177 consecutive spins, `wallet_transactions` debits vs `buy_in_amount * 3` | 531 debit rows, exactly 3 per spin, **15,012.00 charged against 15,012.00 expected** |
| Wait for 3                | third `table_seats.joined_at` -> `spin_reserve_ledger.jackpot_draw`        | p50 **3.2s overnight, 6-14s in the afternoon**, p90 to 28s — see section 4           |
| The draw                  | 21,250 drawn multipliers vs the `spinSpec` ladder                          | observed **E = 2.7628** against the specified **2.7638**                             |
| The wheel                 | live Chromium at 375x667 against the deployed bundle                       | disc 262x262, multiplier and prize painted and fully on screen                       |
| Blinds                    | `blind_structure` vs `SPIN_TIERS.levelMinutes`                             | 12 levels, 180s each, flat across every tier, as specified                           |
| Stack depth               | `starting_chips` vs the drawn tier                                         | 300 / 1000 / 5000 in exactly the proportions the ladder predicts                     |
| Payouts                   | 749 consecutive completed spins                                            | **50,684 owed, 50,684 credited, zero uncredited**                                    |
| Multi-place payouts       | 249 games at 10x and above                                                 | 10x pays 2 at 0.80/0.20; 25x/50x/100x pay 3 at 0.80/0.12/0.08. No deviation          |
| Horses are players (10.5) | 1,584 prize credits in 24h                                                 | every one to a horse, none filtered                                                  |
| Rake attribution          | `vip_points_ledger` vs settled rake                                        | **BROKEN — section 2**                                                               |

Two things I suspected and checked before writing up, both of which turned out
to be correct by design:

- **`starting_chips` is not inconsistent.** 300, 1000 and 5000 all appear, at
  identical buy-ins, which looks like a bug. It is `SPIN_TIERS[].startingStack`:
  the drawn multiplier sets the stack depth. The observed proportions
  (18,572 / 2,725 / 5 over seven days) match the ladder's frequencies to within
  a rounding error.
- **`spin_tournaments` is empty and always has been** (0 rows, lifetime). Spins
  live in `tournaments` with `tournament_type='SPIN'`. The table is dead, not
  broken.

## 2. THE DEFECT — zero recorded as success

`fn_settle_tournament_rake` banks a tournament's rake and calls
`fn_attribute_tournament_rake`, which turns it into VIP credit, agent
commission and rakeback basis for the players who generated it. It stamped
`attributed_at` whenever attribution returned `ok:true` — **and attribution
returns `ok:true` when it credits nobody.**

`fn_repair_tournament_rake_attribution`, the standing 15-minute remedy, selects
on `attributed_at IS NULL`. The one shape it could never see was the one that
had actually happened.

**21,562 settlements. 21,080 chips of banked rake that earned nobody anything.
Back to 2026-08-19.** 17,504 spins, 3,834 SNGs, 198 MTTs.

This is the 2026-08-27 horse-rake failure reached by a different route: a zero
reported as correct behaviour.

### The discriminator, which is exact

| buy-in   | rake credit per player | attributed |
| -------- | ---------------------- | ---------- |
| 1 - 10   | 0.08 - 0.80            | **4 - 9%** |
| 20 - 100 | 1.60 - 8.00            | 100%       |

Anything under 1.00 vanished. Until 2026-08-31 ~10:00 UTC `fn_award_vip_credit`
dropped a credit that did not round to a whole VIP point, and a Spin's rake is
8% of three buy-ins split three ways — 0.08 x buy-in each. Another agent's
fractional-carry fix (`vip_points_carry`) closed the live bug that morning:
small buy-ins went 0% attributed before 10:00 to 100% from 11:00, in the same
hour, with no other change. **The live bug was already fixed. The accounting
that hid it for twelve days was not**, and the debt it had already swallowed
was unreachable by the only sweep that could have paid it.

### The fix

`20260831135007_zero_attribution_is_not_success.sql`:

1. **`attributed_users` is stored, not reconstructed.** Reconstructing it from
   `vip_points_ledger` is a 45-second scan of a 3.8M-row table — that cost is
   precisely why nothing watched this. A column costs nothing, and the backfill
   queue (`attributed_users IS NULL`) drains monotonically because every row it
   touches gets a non-null value.
2. **`fn_attribute_tournament_rake` returns `members`.** That is what lets
   "credited nobody" be told from "there was nobody to credit". Without the
   distinction the repair queue cannot decide whether a retry is worth
   anything, and a genuinely unattributable row pins its head — the failure
   mode the Heads-Up back-pay hit.
3. **The settle path only stamps `attributed_at` when somebody was credited, or
   nobody could be.** Everything else stays queued, so the existing 15-minute
   repair picks it up with no new scheduling and no new sweep.
4. **`fn_backpay_tournament_rake_attribution(p_limit)`** replays the history,
   bounded per call. Safe to run over rows that were already paid because every
   credit path is idempotent on its own unique key —
   `vip_points_ledger(user_id, source_type, source_id)`,
   `agent_commissions(user_id, source_id, source_type)` and
   `rakeback_stats_applied(rake_record_id, user_id)`. Verified: replaying an
   already-credited event moved no points.
5. **`v_tournament_rake_attribution_gaps`** makes the shape visible, with three
   verdicts — `never_measured`, `credited_nobody`, `attribution_threw`.

Nothing in it filters on `is_horse` in either direction (10.5). A horse
generates the same rake and earns the same credit, and the back-pay pays every
seat it finds.

### Verified live

Applied 13:50 UTC. Within six minutes every settlement written by the engine
carried `attributed_users` of 2 or 3, stamped, with no `attribution_error`.
Before the change that column would have been blank on all of them.

The probe that proved the debt was recoverable was run inside a transaction
that was rolled back (11.5) — it returned 3 users and 0.72 chips for a
settlement that had credited nobody, which is what justified building the
back-pay rather than writing the loss off.

## 3. What the live browser E2E actually measured

Not a mock: the deployed bundle, in a real Chromium, at the 375x667 design
floor, with 116 shipped stylesheets pulled from production.

- disc **262x262**, painted, inside the viewport
- drawn multiplier **43x38**, opacity 1, on screen
- prize **340x64** at y 402-466, prize label and splits all above the clip line
  (the insurance modal shipped its decision buttons below that line on this
  exact viewport, hand #3158299)
- vignette spans the full 375px rather than collapsing to a corner
- longest shipped wheel animation **1,800ms**, against the **14,800ms** the
  engine holds the deal for — no beat can be dealt over
- under reduced motion, with `animation:none` applied to the documented
  selectors, every element still resolves to opacity 1. Motion goes, meaning
  stays (10.6)
- the shipped `TablePage` chunk carries the reveal machine, including the
  `revealAtMs` catch-up that lets a late client skip forward instead of
  replaying, and the inaudible-audio report

## 4. Reported, not fixed: the start lane is slower than round 18 shipped

Round 18 moved the wheel to fire on the **draw**, and measured third paid seat
to reveal at p50 3.02s. Measured today, same clock:

| hour UTC | p50   | p90   |
| -------- | ----- | ----- |
| 08:00    | 3.2s  | 5.9s  |
| 11:00    | 7.3s  | 14.3s |
| 13:00    | 13.7s | 28.3s |
| 14:00    | 6.7s  | -     |

It recovers, so it is not a runaway, but it runs 2-4x the shipped baseline
through the working day and does not reset on an engine restart — there were
three in that window. Hand throughput is flat at 10-13k/hour throughout, so the
engine is not broadly starved; the start lane specifically is. The per-game
12-second throttle on `fillPartialSeatFirstGame` is intact, so the obvious
suspect is not it. **Not root-caused, and deliberately not guessed at.**

One measurement trap worth recording: measuring this against `started_at`
rather than the draw shows a much worse and apparently monotonic curve. It is
the wrong clock — the player sees the wheel at the draw, and `started_at` lands
after the bookkeeping. My first reading of this was wrong for that reason.

## 5. Also checked, no defect found

- **Chip conservation.** 15,012 collected, 12,727 paid out, 1,200.96 booked as
  rake, remainder into the reserve pool. The pool absorbs the variance by
  design and its balance is the solvency measure.
- **Spins that never end.** Every RUNNING spin older than 20 minutes was
  dealing hands within the last 3 minutes. The `finishSeatFirstGamesThatOver`
  sweep from round 18 is holding: 58 of 4,570 spins over three days ran past
  level 12, none of them stuck now.
- **Unfilled boards.** `v_spin_unfilled_waits` is empty, and cancelled spins
  carrying players have no buy-in debits to refund — nothing is owed.
- **Prize crediting.** `v_spin_unpaid_settlements` is empty and agrees with a
  direct reconciliation of 749 spins.
- **Stubs.** No TODO, FIXME, stub or placeholder in `SpinWheel.tsx`,
  `spinReveal.ts`, `useSpinTierAvailability.ts`, `useSpinsWallet.ts`,
  `SpinActivationService.ts` or either copy of `spinSpec.ts`.

## 6. Two estate problems this audit ran into

- **The GitHub MCP token is dead.** Every call, including reads, returns
  `Authentication Failed: Bad credentials`. That is RULE 0's primary ship route
  for every agent, and `device_bash` has no network to GitHub either, so there
  is currently no path from a Cowork session to a commit. The database fix went
  through the Supabase MCP and is live; this file, the migration and its test
  are staged on the Desktop and in the worktree awaiting a working token.
- **The device VM's disk is 100% full** (9.8G, 0 available). `vitest` cannot
  create its temp directories, so the suite cannot run there. The 25 pins in
  `rakeAttributionZeroIsNotSuccess.test.ts` were executed against the migration
  with a standalone node runner instead — all 25 pass — but that is not a
  substitute for the real suite running in CI.

## 7. The back-pay, completed and measured

Drained to zero in bounded calls to `fn_backpay_tournament_rake_attribution`,
finishing 2026-08-31 15:0x UTC.

|                                |                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| settlements measured           | **40,055** (queue `remaining` = 0)                                                   |
| VIP ledger rows written        | **69,561** across **21,947** tournaments                                             |
| players credited               | **585**                                                                              |
| rake credit delivered          | **23,314.76 chips / 23,225 VIP points**                                              |
| agent + super-agent commission | **2,248 rows to 74 agents, 1,414.12 chips**                                          |
| rows that threw                | 18, all `deadlock detected` against live traffic; reset and re-run, all 18 recovered |
| rows still owing               | **0**                                                                                |

Attribution rate for completed Spins, by day, before and after:

| day        | before | after    |
| ---------- | ------ | -------- |
| 2026-08-21 | 37.0%  | **100%** |
| 2026-08-22 | 39.8%  | **100%** |
| 2026-08-23 | 36.4%  | **100%** |
| 2026-08-24 | 37.7%  | **100%** |
| 2026-08-25 | 37.5%  | **100%** |
| 2026-08-26 | 37.2%  | **100%** |
| 2026-08-27 | 39.5%  | **100%** |
| 2026-08-28 | 36.9%  | **100%** |
| 2026-08-29 | 37.1%  | **100%** |
| 2026-08-30 | 41.7%  | **100%** |
| 2026-08-31 | 53.6%  | **100%** |

### The fix caught a live event on its first day

At 14:10 UTC, while the back-pay was running, `$100 Freeroll • 6:00 AM`
(390 players, 22.20 chips of rake) hit a deadlock inside attribution and
credited nobody. It was left **unstamped**, appeared in
`v_tournament_rake_attribution_gaps` as `credited_nobody`, and
`fn_repair_tournament_rake_attribution` cleared it on the next pass —
`repaired: 1, queue_after: 0`. Settle, detect, queue, repair, drain: the whole
loop demonstrated end to end on a real event rather than argued for.

The queue is empty and the gap view is empty.
