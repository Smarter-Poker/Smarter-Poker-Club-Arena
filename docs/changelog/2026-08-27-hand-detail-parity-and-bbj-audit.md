# 2026-08-27 — One hand rundown, and the jackpot stops losing its evidence

Dan, with two PokerBros reference screenshots (a PLO run-it-twice and a PLO5):

> 1. you need to make sure that the "HAND DETAILS" looks and is exactly like it
>    appears inside our hand details. don't leave anything out.
> 2. and make sure that smarter.poker looks and feels like this with all the same
>    data points and architecture.
> 3. on the winners page, above the jackpot should be the game type that it was
>    hit on NLH, PLO PLO5.
> 4. and the winning hand should be displayed with the first letter of every word
>    capitalized, and centered under the hand, "Four Of A Kind"
> 5. double the size of the current avatar, and remove the "circle frame".
>    avatars should display here like they do on the table with no background.
>    (remove the "1" pill tag at the bottom.)
> 6. run a thorough deep dive and audit to make sure that this functionality
>    exists to auto update and capture this info when a BBJ does hit.

## 1 & 2 — one rundown, one reconstruction

There were two hand-detail renderers — the jackpot one and the table's Previous
Hand — each walking the hand its own way, and **both were wrong in the same
place**. They are now one component (`src/components/handdetail/HandDetailView`)
over one model (`src/utils/handReplay.ts`), so they cannot drift again.

### `actions[].amount` is not one unit

The engine writes two different meanings into the same field
(`HandController.ts:600-724`): the raise-**TO** level for `bet` / `raise` /
`all_in`, and the chips actually added for `call`. Three separate consumers
summed it as if it were uniformly incremental — `HandDetailModal`'s running pot,
`HandHistoryService.buildResult`, `handHistoryAdapter.investedBy` — so every
raised pot was over-counted.

On real hand 3048511 (PLO5 1/2) the naive sum is **392.20** against a stored
`pot_size` of **324.20**. Differencing each to-level against what that seat
already had in gives 324.20 to the penny.

Measured over the **4,000 most recent live hands: 3,967 rebuild exactly**
(99.18%). The 33 that miss are tournament hands with antes and cash hands with a
straddle — neither is written to `actions` or to any column.

### The stack column, which the reference has and we did not

Nothing stores a starting stack; `players[].stack` is the stack _after_
settlement. It is recovered as `endStack - grossWon + netInvested`, which is
exact — on 3048511 it says Bmorecharles started with 161.10, and he was all-in
for exactly 161.10.

Where the rebuild does **not** land on `pot_size`, the whole column is withdrawn
rather than drawn wrong. That is the same rule the old running-pot column
already followed, and it is what covers the 0.8% tail.

### The three things the log does not record

- **Blinds** are not in `actions` at all — `postBlinds` emits a bus event and
  nothing else. Synthesised from `small_blind` / `big_blind` and the derived
  blind seats, and only when the log does not already carry post rows.
- **An uncalled bet** is never recorded, while `pot_size` and the ending stack
  both already exclude it. Inferred: at the end of a street the top
  contributor's excess over the next highest was matched by nobody. That is the
  `return` row with a negative amount the reference shows.
- **Antes and straddles** are not recoverable from a `hand_history` row at all.
  Recorded, not faked.

### Everything else the reference shows, now shown

Per-street `Pot Main(x)` line · the whole board face-up on each street header
(3 / 4 / 5, not just the new cards) · face-down cards beside a fold · face-up
cards on a reveal · the showdown ordered by the engine's own `reveal_order` with
the muck ruling honoured · run-it-twice boards (from `rit_boards` **and** the
legacy `rit_board_N:` pseudo-action) · a double-board bomb pot's second board ·
the real main/side split from `pots` · rake and jackpot drop · the **BBJP
Winners** box with each player's `(ID:xxxxxx)`.

Three columns `hand_history` has carried since 2026-08-25/26 — `showdown`,
`pots`, `rit_boards` — were in no payload and no reader. `fn_bbj_hand_detail`
returns all three now.

### A bug found on the way

`HandHistoryService` derives the button from `players[].isButton`, a field
**nothing in the codebase has ever written**, so it falls back to seat 1 and
every position badge the table draws is wrong. `button_seat` has been written
correctly the whole time and was simply never selected. `useHandReplayModel`
reads the real column.

## 3, 4, 5 — the winners rows

- **Game type** above the payout, in the same column (`NLH`, `PLO4`, `PLO5`).
- **Hand name Title Cased and centred under the cards** — the casing is done in
  the component so it also reaches the row's `aria-label`; the centring is on
  the card strip, not the column.
- **Avatar doubled (48 → 96px), frameless.** The row no longer uses
  `PlayerAvatar`, which draws a circular crop, a VIP ring, a presence dot and
  the level badge that the "1" pill came from. The library art is a
  free-standing bust with its own transparency, so it renders as a bare `<img>`
  exactly as the felt does it.

## 6 — the audit

Full write-up: `.agent/audits/2026-08-27-bbj-live-capture-and-realtime.md`.

**Detection and payout are real and correct.** `detectBBJHit` is wired into the
hand-completion path, and `bbj_atomic_payout_v2` writes `bbj_payouts`,
`bbj_payout_recipients` — including every other player dealt in — and
`bbj_winners`. All 29 production payouts have recipients that sum exactly to
their total.

**Two things were broken.**

1. **The hand was being deleted.** 24 of 29 jackpot payouts have no
   `hand_history` row. All 24 are real hits. `sp_prune_hand_history` removes
   all-horse hands after 7 days — right for the 1.5M hands a week the fleet
   generates, catastrophic for the handful that hit the jackpot, because the
   winners list keeps the last five hits _forever_. And `bbj_payouts.hand_id` is
   hardcoded NULL, so once the row is gone nothing can rebuild it. A hand a
   payout points at is no longer a prune candidate.

2. **The winners list was the only BBJ surface that was not live.** The pool
   ticker, the table celebration, the platform-wide announcement and
   `BBJTicker` were all subscribed; `BBJRecentHits` — the list a player opens
   _after_ a jackpot — refetched only on mount. It now subscribes to
   `bbj_winners` INSERT.

**And the money path was not in version control at all.**
`bbj_atomic_payout_v2` and `bbj_credit_one_recipient` existed only in the
production database; the repo held the superseded v1, which pays nobody. Both
captured verbatim, verified by normalised md5 against `pg_get_functiondef`.

Four smaller gaps are recorded in the audit and deliberately not fixed here.

## Correction to an earlier claim today

The first pass at this said "the table share was never paid". That was true of
the five **seeded** payouts and false of the live path, which has been paying it
correctly the whole time. The audit measured it: zero payouts with no
recipients, zero whose recipients do not sum to the total.

## Not verified end-to-end

The most recent real hit is 2026-08-19, so the full chain has not been observed
on one live jackpot under today's code. Every link is verified individually, and
the join is proven safe — zero duplicate `(table_id, hand_number)` pairs across
1.56M rows.
