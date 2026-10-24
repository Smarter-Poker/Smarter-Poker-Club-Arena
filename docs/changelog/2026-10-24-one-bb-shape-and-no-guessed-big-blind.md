# One BB shape, and no guessed big blind (2026-10-24)

Follow-up to `2026-10-24-the-pot-follows-the-stack-display.md`, after Dan asked what else could be improved.

## 1. Every BB figure has one shape

With stacks in BB the pot printed `50 BB`, the seat beside it `50.0 BB` and a bet `6.0 BB`: three formatters for one setting. The rest of the platform (tournament structure cards, the cash panel) already reads `50 BB` / `87.5 BB`. `formatBigBlinds` in `src/utils/format.ts` is now the one shape: whole and grouped from 100 BB up (`1,250 BB`), no decimal for a whole number (`50 BB`), otherwise one decimal (`37.5 BB`). The pot, the seat stack, the bets in front of seats, the Call / Bet / Raise label, the winner's +N and the raise panel's BB readout all print through it. With no big blind it returns null and the caller prints chips, never `0 BB`.

## 2. The felt never divides by a guessed big blind

`seatBigBlind`, the figure the seats and the pot print against, fell back to 2 while the table's blinds were unknown (`?/?` on a fresh Lightning room or auto-seat). On a 5/10 table opened in that window every stack showed five times too many big blinds. It now falls back to 0: every amount prints in chips, pot and seats together, and the whole felt switches to BB the moment the real blinds land. Game logic that needs a working blind (the raise panel's `bb`) is unchanged.

## Pinned by

`tests/the-pot-follows-the-stack-display.law.test.tsx`, extended: 6 of its 15 checks fail on the previous code.
