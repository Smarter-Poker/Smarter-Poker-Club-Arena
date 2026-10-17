# Double Diamonds is retired from the Diamond Spins bonus games (2026-10-17)

Dan, 2026-10-16, verbatim: "REMOVE THE DOUBLE DIAMONDS FUNCTIONALITY FOR THE
BONUS GAMES ON THE DIAMOND SPINS. ITS CONFUSING TO SOME PLAYERS."

## What players see now

A game won on Diamond Spins (Plinko, Crash, Donkey Cross, Diamond Mines) opens
straight on its own setup. There is no "Double Your Diamonds" screen, no
"Diamonds Added: Change" line and no Double Down box. The game plays exactly
the diamonds the wheel funded, and the only tap that starts it is the player's
own Start (R1 and R9 unchanged).

## What changed

Client:

- `src/components/games/DoubleDownOffer.tsx` is deleted. `BonusSetup` no
  longer has an offer step (`bonusEntryStep`, `offerAnswered`,
  `onOfferAnswered` are gone), a "Change" button, or the award-less Double Down
  checkbox.
- `useBonusBudget` drops the per-award offer memory and reads back any
  selection an older page saved with the add-on WITHOUT it.
- `useEarnedBonus` and `awardBudget` always quote an award undoubled
  (`p_double: false`).
- The Plinko, Crash and Choice pages lose every "Answer The Offer First" /
  "Turn Off Double Down" branch; the Choice road is paused only behind its
  receipt.
- Lobby and operator copy no longer mention the add-on or the Super Double
  board; `DiamondTestPage` loses its Double Down button and `?double=1`.

Server, `20261017040017_double_diamonds_is_retired_from_the_wheel_bonus_games`:

- `fn_wheel_bonus_start` and `fn_diamond_bonus_start` refuse a new start with
  `p_double = true` ("Double Diamonds Is No Longer Offered. Refresh To Play
  Your Bonus."), so a tab still holding the previous bundle cannot start one.
- The refusal sits AFTER each function's replay branch and BEFORE any write: a
  round an older page opened with the add-on was paid for and still replays
  its own receipt, and a refused start charges nothing.
- Both bodies are otherwise the live definitions byte for byte (md5 of the
  pre-change `prosrc` matched the file with the four new lines removed).

## What was kept on purpose

- The `p_double` parameters and the `doubled` field on `BonusBudget`: every
  historical doubled round still has to replay and read back
  (`earnedReceiptBudget`, the saved-wager replay in `diamondBonusRecovery`).
- The "Double Down" line on Diamond Spin statements, which reports diamonds
  already spent on it.
- The Super Double (6) board in `PLINKO_TABLES`, which sealed rounds name.
- The SQL acceptance probe `diamond-wheel-maximum-and-double-down.sql`, which
  certifies the earlier function definitions it installs itself.

## Pinned by

`tests/double-diamonds-is-retired.law.test.tsx`
(`docs/laws.d/double-diamonds-is-retired.md`).
