# tests/the-pot-follows-the-stack-display.law.test.tsx

Dan 2026-10-24: switching the stack display from totals to BB must switch the pot too. The pot on the felt is handed the same big blind the seats are (`seatBigBlind`), never a private read of the blinds string with its own fallback, so an unparsed blinds string ("?/?" on a fresh Lightning room or auto-seat) can no longer leave the stacks in BB and the pot in chips; and in BB mode the POT pill, every side pot, the TOTAL row and the spoken label all read BB.
