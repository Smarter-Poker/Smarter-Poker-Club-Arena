# The pot follows the stack display (2026-10-24)

Dan: "WHEN YOU CHANGE YOUR STACK FROM A TOTAL TO BB IT SHOW THE TOTAL POT AMOUNT IN THE POT AS TOTAL CHIPS INSTEAD OF BB'S. THAT NEEDS TO BE UPDATED."

## Cause

The pot, the seats and the raise panel all read `user_table_settings.show_stack_in_bb`, but not the same big blind. Every seat and the raise panel used `safeBB(tableState.blinds)` (fallback 2); the pot alone used `safeBB(tableState.blinds, 0)`. `PotDisplay` prints BB only when its big blind is above zero, so whenever the blinds string was not a clean pair (a Lightning room seeds `?/?` until its cluster meta lands; an auto-seat or a tab opened without the lobby card has no blinds until the table row lands), the stacks switched to BB and the pot kept printing chips.

## Fix

- `TablePage`: the pot is handed `seatBigBlind`, the exact figure the seats use. One big blind, one setting, every number on the felt follows it.
- `PotDisplay`: the spoken label uses the same formatter as the pill, so it reads BB in BB mode too.
- `SeatSlot` / `ChipPhysics`: the same split sat one seat over. The bet chips in front of each player, the Call / Bet / Raise label and the winner's +N always printed chips while the stack beside them read BB. They now print through one seat formatter (`formatSeatWager`) that follows the setting and the stack's own big blind; with no big blind to divide by it keeps the chip figure instead of a false "0 BB". `ChipPhysics` takes an optional `formatAmount` for this, defaulting to the chip figure it always printed.

## Pinned by

`tests/the-pot-follows-the-stack-display.law.test.tsx` (registered in `docs/laws.d/`).
