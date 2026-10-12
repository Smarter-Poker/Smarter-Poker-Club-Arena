# A seat just taken is not a bust (2026-10-06)

## What happened

Production `chip_ledger`, 2026-10-04, one player at a table with a 1,000.00
maximum: `19:40:05 buyin 1000.00`, `19:40:11 rebuy 1000.00`,
`19:41:24 player_funding +990.00`. Six seconds after buying in, holding a full
stack, the player was shown the bust-rebuy prompt and confirmed it. The engine
applied 10.00 and refunded 990.00 over a minute later.

## What is and is not known

The prompt opens when the hero's seat shows a zero stack and no hand is in
progress. The database seat row is written with the full buy-in, so the zero
came from the page's own state in the seconds before the table's snapshot
reported the stack. Which message produced it has NOT been reproduced, and
this change does not claim to have found it.

## What this change does

It removes the condition under which that zero could cost anything.
`bustPromptMustWait` (`src/utils/bustPromptGate.ts`): inside the fifteen
seconds after THIS tab took the seat (the window the page already treats as
unsettled for a fresh seat), a zero stack that has never been preceded by
chips is not offered a rebuy; the watch looks again when the window closes. A
bust is a fall to zero, so once chips have been seen for that seat the prompt
is immediate, exactly as before. A seat this tab did not take (a reload onto a
real bust) is also prompted at once.

With "an idle table finds the chips it owes" (earlier today) the refund of
any such rebuy also no longer waits for the next hand or restart.

## Proof

`tests/unit/aSeatJustTakenIsNotABust.test.ts`, including the production
timing (six seconds after the buy-in: wait nine more).
