# A buy-in draws from the wallet that can pay, and no unfunded seat is held

Dan, 2026-10-12 (items 4 and 5 of that day's list):

> 4, Club arena - can't buy into tournaments or cash games even with chips in account.
> 5, A player should not be able to "hold a seat" if they don't have sufficient chips. That
> should be checked before the seat is "reserved". And there is not point to have a pop up with
> "This seat is reserved click to take it." That's already assumed and doesn't need a pop up.

## What happened, read from rows

Dan plays as **kingfish**, the owner of Club JAQK, SHARK CLUB, Midway Union and Deep Stack
Society. On 2026-10-11 at 21:48 UTC the Join Game door held him a chair at NLH 2/5 Classic
Feeder (a Midway Union game; `table_waitlist` row `c4970393`, expired unused). The buy-in
sheet showed BALANCE 4.50 against a 200 minimum. The Evening Mystery Bounty (PLO5) Sign Up
card showed 0 Chips against a 15 entry. His SHARK CLUB wallet held about 2,650 at the time.

The 484.2K figure on both screenshots is the Diamond Spins button: diamonds, not chips.

1. **A union game charges one member club,** the club the player came in through when it is a
   member club, otherwise their oldest membership. For kingfish that was Club JAQK (4.50 then).
   Nothing asked whether that wallet could pay, so every union buy-in and entry was refused
   while another of his clubs in the same union could cover it many times over.
2. **The Sign Up card asked by the tournament's club,** which for a union event is the union's
   house club (Midway Union, 0.00). The entry is charged to a member club, so the card showed a
   wallet that is never charged.
3. **The join door held the chair first,** for sixty seconds, and only the buy-in asked about
   money afterwards. The waitlist offer did the same.
4. **The "Seat Held, Tap To Take It" card and the "A Seat Just Opened For You" toast** sat on top
   of the buy-in sheet that the same hold had just opened.

## What changed

Migration `20261012131301_a_buyin_draws_from_the_wallet_that_can_pay_and_no_unfunded_s`:

- **Cash buy-in** (`atomic_table_buyin`): when the default wallet cannot cover the amount, the
  player's union member club that can (richest, ties to the oldest membership) is passed to the
  gate as the preferred club. `fn_seat_club_for_user` already honours a preferred member club,
  so the debit, the seat stamp and the cash-out all name it. Nothing changes when the default
  can pay, at a standalone club table, at a Diamond table, or for a player already seated in the
  union (one club at a time).
- **Buy-in sheet** (`fn_player_spendable_balance`): reads the wallet the buy-in will spend, by
  the same rule at the table's minimum.
- **Tournament entry** (`fn_register_for_tournament`, `fn_register_horse_for_tournament`): when
  the default member club cannot cover the entry, the door declares the club that can for this
  transaction only (`app.ca_entry_paying_club`, keyed on tournament and player).
  `fn_tournament_club_for_user` honours it, so the debit, the wallet log and the roster stamp
  agree. The person's door and the horse's door use the identical rule (CLAUDE.md 10.5).
- **An entry's later money** (`fn_tournament_club_for_user`): once on the roster, rebuys,
  re-entries, add-ons and prizes resolve to the club stamped on the entry. Refunds already used
  the club the charge left (`tournament_refund_entitlements.refund_wallet_club_id`).
- **Sign Up card**: the client now reads the balance by tournament
  (`WalletService.readPlayerBalance({ tournamentId })` -> `p_tournament_id`).
- **Holds** (`fn_cash_game_join`, `fn_offer_open_seat`): no chair is held for a player none of
  whose spendable wallets covers the table's minimum (rejoin floor included). The join door
  refuses with `INSUFFICIENT_CHIPS:<need>` before writing anything, and the lobby says "Not
  Enough Chips. You Need At Least 200 Chips To Join This Game." The waitlist offer passes such a
  player over for that seat and keeps their place, as it already did for a capped player.
- **No hold popup**: the waitlist banner shows a place in line only, and the listener raises no
  toast for a held seat. The buy-in sheet still counts the hold down in its own pill, and a
  player waiting elsewhere is told by the "Seat Open" notification `fn_offer_open_seat` writes
  (bell and push).

## Proof

Every function was copied from production and proven byte-identical (md5 of
`pg_get_functiondef`) before it was edited; the migration refuses to install over anything else.

Before applying, a rolled-back probe ran the new functions as temporary copies against live rows:

| Case                                                    | Result                          |
| ------------------------------------------------------- | ------------------------------- |
| kingfish, 2/5 Feeder, came in through Club JAQK (24.50) | charged and shown SHARK CLUB    |
| kingfish buy-in sheet                                   | 2,653.74 (SHARK CLUB)           |
| kingfish Sign Up, 100 Chip Spin PLO6                    | 2,653.74 (SHARK CLUB)           |
| danbek4545 (Club JAQK 10,000 covers it)                 | unchanged                       |
| Smarter.Poker Official (no wallet holds 200)            | join refused, no hold           |
| Declared club for kingfish, resolved for danbek4545     | not steered (Club JAQK)         |
| A club the caller names                                 | still wins over the declaration |

Law: `tests/a-buyin-draws-from-the-wallet-that-can-pay.law.test.ts`. The banner tests
(`tests/unit/seatHoldCountdown.test.ts`, `tests/unit/globalWaitlistSdkTransport.test.tsx`) now
pin that no held-seat card or toast appears; they pinned the card's internal clock (Dan
2026-09-23) until this ruling replaced it.
