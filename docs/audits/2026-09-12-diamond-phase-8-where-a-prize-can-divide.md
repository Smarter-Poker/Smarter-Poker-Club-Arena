# Diamond Phase 8 Survey: Where A Prize Can Divide

Status: Phase 8 In Progress. Diamond Tournaments Are Refused At Every Door. This Is The Map, Not A Claim Of Work Done.

## Why This Document Exists

Phase 8's exit is "all funded tournament lifecycles close exactly and cannot pay playing-stack units to wallets." Both halves are about a unit that does not divide, pointed at a money path that has assumed a cent since it was written. This records what was found before any of it was changed, so the next piece of work starts from the map rather than rediscovering it.

## The Shape Of The Problem

Diamond tournaments are refused **structurally**, not by a switch. `ca_arena_settings` has exactly one admission flag, `cash_games_enabled`, and no `tournaments_enabled` sibling. The refusals live in the boundary rule and the custody doors:

- `fn_poker_diamond_plain_cash_table` refuses `tournament_id IS NOT NULL`.
- `assertDiamondCashTable` refuses the same, and it is the only thing `loadTable` calls for a Diamond arena, so a Diamond tournament table cannot be loaded by the engine at all.
- `seatCanAddFunds(asset, isTournament)` returns false for a Diamond tournament seat, which is what keeps the four top-up controls off it.
- `fn_poker_diamond_open_cash_table` hard-codes a NULL `tournament_id`.
- `fn_poker_diamond_settle_cash_hand` keeps `tournament_id IS NULL` even as its variant list widened.

**One thing is already half-built.** `poker_diamond_custody.purpose` permits `cash_seat` and `tournament_entry`, and `fn_poker_diamond_reserve` already knows how to price a `tournament_entry`: it reads `tournaments.buy_in_amount + buy_in_fee` and refuses anything else with `invalid_diamond_entry_price`. Nothing has ever written such a row. Every live caller passes the literal `cash_seat`. The escrow shape exists and is unused.

## The Eight Places A Prize Can Divide

None of these took a unit argument before this phase. The only unit-aware money code in the estate is the hand engine, which learned it in Phase 7; the tournament ladder never did.

| #   | Site                                    | Arithmetic                                                                      | Fractional on a whole pool?                                                                                                    |
| --- | --------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `fn_ca_tournament_place_amounts`        | `round(pool_cents * bp / total_bp)`, last place takes the remainder             | **Yes.** The canonical payout division.                                                                                        |
| 2   | `computePlacePrize` (`payoutMath.ts`)   | the TS mirror of 1                                                              | **Yes.** **Fixed 2026-09-12.**                                                                                                 |
| 3   | `fn_tournament_place_prize_exact`       | a third copy of the same rule, used by the reprice path                         | **Yes.**                                                                                                                       |
| 4   | `fn_settle_tournament_final_table_deal` | `floor(chips * undistributed_cents / total_chips)`, residual to the chip leader | **Yes.** Proportional to play-chip stacks, so almost never a whole Diamond.                                                    |
| 5   | `fn_collect_bounty`, multi-claimant     | `floor(cents * w / total_weight)`, last claimant takes the rest                 | **Yes.** A bounty chopped between two all-in winners.                                                                          |
| 6   | `fn_collect_bounty`, PKO half           | `v_cash_cents := (v_share_cents / 2)`                                           | **Yes.** A 1 Diamond bounty is 50 cents cash and 50 cents to the head.                                                         |
| 7   | `mysteryBountyActivation.ts`            | `floor(bountyPoolCents * m / total)`                                            | **Yes.** The regular half deliberately keeps the odd cent.                                                                     |
| 8   | the rebuy fee ratio                     | `trunc(gross * ratio * 100 + eps) / 100`, capped at 10 percent                  | **Yes, and it is the worst.** Truncation of a RATIO to cents, on every rebuy and re-entry, flowing straight into `prize_pool`. |

Two that are **safe** and worth recording so nobody re-checks them: the satellite seat award is `floor(pool / ticket_cost)` with a remainder, whole by construction when both are whole; and bubble protection is a subtraction of one buy-in, not a division.

**Ties cannot happen.** Finishing positions are unique, enforced three ways: a unique index on `(tournament_id, kind, place)`, a preflight that forbids duplicate `(tournament_id, position)`, and a caller that refuses `v_holders <> 1`. Simultaneous busts are ordered, not chopped. The only money chop in the tournament path is the final-table deal.

## Three Copies Of One Ladder

Sites 1, 2 and 3 are the same rule written three times, in two languages, with three spellings. That is the drift pattern this estate was bitten by twice on 2026-09-12 alone: the plain-cash rule had become five rules, and the games list had become five copies.

Site 2 now takes a unit. Sites 1 and 3 do not, and `fn_tournament_payout_reconcile` implements the ladder a fourth time in order to check the others. The right repair is one ladder function that all of them call, with the unit as a parameter, and the empirical safety argument is strong: for a chip tournament the unit is 1 and the snap is the identity, so the chip path is unchanged by construction rather than by inspection.

## A Chip-Side Defect, Found And Not Fixed

A pool holding fewer units than there are places pays the **last** place everything and the first place nothing, because every non-last share rounds to zero and the last absorbs the pool as its residual.

At cent granularity this needs a nine-place event with a pool under nine cents, which is unreachable. At Diamond granularity it is one short field away, so the Diamond path now pays the places it can, one unit each from the top.

The chip path is deliberately unchanged, because `payoutExactness.law.test.ts` reproduces the old answer in a BigInt reference on purpose: the SQL reconciler implements the same rule and that law exists to keep the two agreeing. Repairing it for chips means moving the reconciler and the law's reference in the same commit, which is a chip-estate change rather than a Diamond slice.

## Playing Stacks Versus Prize Money

The exit clause "cannot pay playing-stack units to wallets" already has a working chip implementation to mirror, and it exists because the failure happened: **46.4 million chips were minted into horse wallets between 2026-08-24 and 2026-08-31**, because the engine called `atomic_table_cashout` for horse seats on tournament-attached tables.

The guard added afterwards is the shape to copy: `atomic_table_cashout` detects `tournament_id IS NOT NULL`, raises a drift incident, closes the seat and returns zero. Two supporting guards bound the felt to the issued play-chip supply, and `fn_leave_seat_and_refund` on a tournament table refunds the entry and never the stack.

A tournament stack lives in `tournament_players.chips` and `table_seats.stack`. Prize money lives in `tournaments.prize_pool` / `bounty_pool` / `total_rake`, `tournament_escrow`, `tournament_obligations`, `tournament_payouts` and the wallet. They share no column.

## Test Coverage Today

Roughly forty test files cover tournament payouts, pools, refunds and cancellation, including several binding laws: a BigInt exactness reference, a single-settlement-path law, one-payment-one-row, a-place-is-not-a-bounty, and a pool-that-is-paid-owes-nobody.

**Not one of them exercises a non-chip asset.** Every file contains zero occurrences of "diamond". The Diamond unit-integrity laws all live on the hand side and none touches a prize pool.

## The Order The Rest Of This Phase Should Go In

1. **One ladder, with the unit** — collapse sites 1, 3 and the reconciler's fourth copy into the function site 2 now mirrors, and give it the unit. This is the largest single risk reduction available and it removes a known drift shape.
2. **The rebuy fee ratio (site 8)**, because it is the only one that runs on ordinary play rather than at settlement, and it feeds the pool that everything else divides.
3. **Escrow**: write the first `tournament_entry` custody row, and give the arena a `tournaments_enabled` flag so the door has a switch rather than only a structure.
4. **The chop and the bounties** (sites 4, 5, 6, 7).
5. **The stack-to-wallet guard**, mirroring the chip one, plus the restart-recovery and finishing-position evidence the checklist names.
