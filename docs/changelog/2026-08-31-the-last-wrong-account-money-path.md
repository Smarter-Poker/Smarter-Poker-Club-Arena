# The last wrong-account money path is gone

**2026-08-31.** Completes phase 3 of 7. Migration `20260901000004`, applied.
Companion to **Smarter-Poker-World-Hub#1120**.

Dan: _"FIX THIS, REMOVE IT IF ITS AN UNUSED LEGACY."_

## Four paths were still on the wrong account

Rewiring `ChipTransferModal` was not the whole job. Four more remained:

| Path                                  | State                                                   | Outcome |
| ------------------------------------- | ------------------------------------------------------- | ------- |
| `AgentService.transferToPlayer`       | **LIVE**, from `SuperAgentDashboard`                    | Rewired |
| `AgentService.distributeFromTreasury` | Zero callers                                            | Removed |
| `AgentService.distributeChips`        | Only caller `ChipDistributionPanel`, **never rendered** | Removed |
| `AgentService.transferToAgent`        | Zero callers                                            | Removed |

### The live one was broken twice over

`transferToPlayer` called `ChipFlowService.transfer` — a peer-to-peer move
between two users' **player** wallets, not the agent wallet. And
`SuperAgentDashboard` passed **`agent.id`**, the agents-table _row_ id, into a
parameter read as a **user** id. No wallet ever matched it, so the one live
caller of this method could not have moved a chip. The wrong account barely
mattered because the send could not land at all.

It now calls `fn_agent_wallet_send`. **The sender is no longer a parameter** —
the RPC derives it from `auth.uid()`, which is the only identity a browser can
establish, and is precisely why the row-id bug was possible. Every send carries
a uuid `op_id` and the result is checked.

## And the function underneath

`transfer_chips_agent_to_player` debits `club_members.chip_balance`. The phase 3
plan said to drop it, recorded as having zero callers; it had four, so the drop
was deliberately deferred. All four are now resolved:

1. The World Hub route that called it is removed (#1120). It was unused legacy —
   its only client was `distributeFromTreasury`, which nothing called, and the
   route **had never successfully run**: zero `chip_distribution`,
   `promo_distribution` and `fraud_attempt_distribute` audit rows, and zero
   `agent_to_player_transfer` rows in `chip_transactions`.
2. `fn_union_money_path_check` treats a listed function that has been _"deleted
   outright"_ as a breach, in its own words.
3. `fn_club_arena_global_wallet_check` listed it.
4. `fn_union_overload_check` listed it.

The function is dropped and all three guards are re-created without the entry
**in the same transaction**, so the estate never sees a half-state where the
function is gone and a guard is still asking for it.

**Nothing was added to those guards in its place.** Widening an estate guard to
cover the replacement is a separate decision with its own blast radius, and
making it silently inside a removal migration is how a guard ends up asserting
something nobody chose.

## Verification

Dry-run in a rolled-back transaction first, then applied. After applying:

```
transfer_chips_agent_to_player signatures ....... 0
fn_union_money_path_check breaches .............. 0
fn_club_arena_global_wallet_check breaches ...... 0
fn_union_overload_check overloaded paths ........ 0
lingering source references ..................... 1  (a comment in the guard
                                                      explaining the removal)
estate credit_used .............................. 0.00      unchanged
estate agent_wallet_balance ..................... 6,726,000  unchanged
```

`tsc --noEmit` clean on client and server. New law test
`tests/the-last-wrong-account-path.law.test.ts`.

## Where chips move now

One path, everywhere: **`fn_club_bank_send`** for the four bank roles and
**`fn_agent_wallet_send`** for the three agent roles. Both enforce their own
authorization, take a uuid `op_id`, write one `chip_transactions` row and open a
ten minute clawback window. The Cashier, the Trade grid, the Wallet Cashier,
`ChipTransferModal` and `AgentService.transferToPlayer` all use them.

## Noted, not done

`ChipFlowService.transfer` now has **zero callers** in `src/`. It is a generic
player-to-player wallet move with its own unit tests, not a club money path, so
it is left in place and flagged rather than deleted in a migration about
something else.
