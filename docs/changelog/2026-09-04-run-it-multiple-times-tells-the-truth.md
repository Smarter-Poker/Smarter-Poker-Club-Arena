# 2026-09-04 - Run it multiple times tells the truth

Branch: `fix/run-it-multiple-times-tells-the-truth`. Dan, with three
screenshots of hand #6145364 (PLO6 1/2, Shark Club / Midway Union, run it
3 times) and the hands after it.

## What the database says happened

|                   |                                                          |
| ----------------- | -------------------------------------------------------- |
| Board 1           | 3s Kh 5c 2h Jd                                           |
| Board 2           | 9c 5s Qs 8s 3d                                           |
| Board 3           | Ts Qc Ah 6h 2d                                           |
| Dan (KingFish)    | Jc Tc 8h 9h 5h Th                                        |
| BluffFox (all in) | Kc 7d 6c Ad 8c 9s                                        |
| Pot / rake / net  | 4.40 / 0.44 / 3.96                                       |
| Paid              | 3.96 to Dan, one `winners` entry, "Two Pair", potIndex 0 |

All three boards WERE dealt server-side (`rit_boards` holds boards 2 and 3).
By the cards, PLO6 (exactly two hole + three board):

- Board 1: Dan Jc+5h = two pair Jacks and Fives; BluffFox best is Kc+Ad =
  pair of Kings. **Dan.**
- Board 2: Dan Jc+Tc with 9 8 Q = Queen-high straight; BluffFox 7d+6c with
  9 8 5 = nine-high straight. **Dan.**
- Board 3: Dan Tc+Th with Ts = three Tens; BluffFox Ad+6c with Ah 6h =
  Aces and Sixes. **Dan.** (Dan: "I didn't win the last board" - trips beat
  two pair; the felt never showed him run 3's result, which is the bug.)

So the 3.96 is a correct triple scoop and no money moves. Across 8,295 RIT
hands in the last 7 days the engine's per-board split is right (1/3 + 2/3,
chops halved). What was wrong is everything the player was SHOWN, and the
record.

## Six defects, all client, plus one record

1. **"Waiting For Players To Run It Multiple Times." over the result.** Each
   accept shows a named banner for 3.5s and then reverts to the waiting strip
   _while the offer deadline is in the future_ - and the 25s window always
   outlives a fast consent, so the strip came back with no expiry.
   `rit_all_accepted` suppresses its own banner when a named one is fresh, and
   `rit_result` never touched the strip. Consent now zeroes the deadline and
   clears the strip; `rit_mandatory` and `rit_result` do the same.
2. **"RUN IT / 0s Left" red in the tab strip for the rest of the session.**
   The deadline was cleared by one effect keyed on `showRIT` changing. The
   panel opens on a 1500ms timer; consent completing inside it makes
   `setShowRIT(false)` a no-op on already-false state, the effect never runs,
   the deadline outlives the hand. Cleared now at consent, at the result, and
   in the hand-boundary reset; and the strip refuses to render an expired
   clock at all.
3. **"TRIPLE SCOOP!" while run 1's flop was still landing.** The label fired
   on a flat 2.2s timer outside the RIT hold that already delays the chip
   ship. It now waits for the last run's ribbon (`ritRevealEndsAtRef`), and
   when `pot_win` beats `rit_result` onto the wire it waits for the timeline
   to be known, bounded.
4. **The opponent's hand "mucked".** The server said `mucked:false` and sent
   the cards. The client's loser-muck timer flew them off 2.4s after
   HAND_COMPLETE - on a 3-run hand, while run 1's flop was landing, ~18s
   before the last ribbon. The muck now waits for the reveal to finish, as
   the reset hold already did.
5. **Run 3 with cards and no result.** By design (2026-08-26 PokerBros
   parity) all boards deal first, then the winner phase replays run by run,
   one 2.6s window each. Run 3's label lands last. With the strip, the
   banner and the muck fixed, that sequence reads as intended; the order is
   unchanged.
6. **Rebuy "failed to load", then stood up.** After the bust the balance read
   failed once; TablePage kept it as `null` (2026-08-27 fix) but
   `TableModalsLayer` did `?? 0`, so `BuyInModal` rendered INSUFFICIENT
   BALANCE on a player holding 495k and could not be confirmed. No rebuy was
   ever attempted (no ledger row), and the engine's busted-seat sweep stood
   him up 76s later. The read now retries once; null stays null through the
   layer; the modal says "Unavailable" with a Retry and labels the confirm
   "Balance Unavailable", never "Insufficient".

**The record.** `hand_history.winners` is one aggregated entry per player with
BOARD 1's hand name, so the scoop above was written as "Two Pair" and a
split is two totals with no board on either. The engine already builds the
per-run truth (`currentHandWinnersByBoard`, what the felt's run headers read
off `pot_win`) and dropped it at the write. New column
`hand_history.winners_by_board` (applied), NULL on single-board hands so
ordinary rows are unchanged. This is what a truthful Previous Hand view
reads next.

## Not changed, on purpose

- The reveal ORDER (all boards, then results run by run) is the 2026-08-26
  parity decision and the server's post-hand hold is computed from it.
- `BUSTED_GRACE_MS` (10s before an unfunded 0-stack seat is released). The
  boot was caused by the rebuy never being attempted, which is fixed; whether
  ten seconds is the right grace is Dan's call.

## Tests

`tests/run-it-multiple-times-tells-the-truth.law.test.ts` (registered) pins
each correction; `tests/unit/buyInModalUnknownBalance.test.tsx` renders the
null case. The 2026-08-25 sweep's pin on the bust read moved to the new
helper in the same commit.
