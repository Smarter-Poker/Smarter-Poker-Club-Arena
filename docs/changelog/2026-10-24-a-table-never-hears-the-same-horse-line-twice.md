# A table never hears the same horse line twice (2026-10-24)

## What Dan saw

Two screenshots of one table's chat, 9:44 PM and 10:07 PM:

- lena: "46 bb on the river, somebody wanted to see my cards"
- lake11: "80 bb on the river, somebody wanted to see my cards"

Dan, verbatim: "HORSES CAN NEVER EVER EVER BE REPEATING THE SAME LINES ... INSIDE
OF CHAT! WTF THIS IS SCREAMING I AM A BOT!!"

## The cause, read from the code

1. `big_pot_won`, `showdown_loss`, `big_hand_shown` and `arrival` held ONE line
   per voice in `server/src/services/horseTableTalkLines.ts`. Every needler
   horse that won a 40 bb pot could only ever type that one sentence.
2. The reuse guard compared the right thing (the template, digits folded) but
   its table window was 20 minutes. The two lines were 23 minutes apart.
3. The guard lived only in the claim. The line was chosen first, blind to what
   the table had heard, and a heard phrase was refused instead of replaced, so
   a deep pool could not help either.
4. Phrase identity ignored the voice styler's shorthand: one horse's "nh" and
   another's "nice hand" counted as different lines.

## The fix

- `HorseTableTalk.say` reads the table's and the horse's last 24 hours from
  `horse_table_talk_ledger` BEFORE choosing (`readTalkHistory`), and
  `chooseLine` skips every phrase in that set: the horse's own share first,
  then the rest of its voice, then silence (`no_fresh_line`). Never a repeat.
- `PHRASE_TABLE_WINDOW_MS` and `PHRASE_HORSE_WINDOW_MS` are 24 hours. A table's
  chat is a scroll a player reads all session.
- `normalizePhrase` folds the shorthand both ways (nh/nice hand, gl/good luck,
  wp, ty, thx, u, ur, cnt, apostrophes). It is idempotent, so ledger rows
  written under the older identity are re-folded on read.
- A history read that fills its cap (`TABLE_HISTORY_LIMIT` 2,000 /
  `HORSE_HISTORY_LIMIT` 400) is "could not tell" and the horse stays silent
  (CLAUDE.md 10.86). The reads use the existing
  `idx_horse_table_talk_ledger_table_said` / `_horse_said` indexes; no
  migration.
- The claim keeps the same phrase check as the cross-process race backstop
  (refusal renamed `phrase_table_24h`).
- Every cell of the pool now holds at least 8 distinct phrases; the four
  one-line events hold 11 to 18 per voice. The pool went from about 200 lines
  to about 400, all through the same sanitizer, placeholder and profanity law.

## Pinned

`server/src/services/HorseTableTalk.test.ts`, describe
"LAW: a table never hears the same line twice": every event and voice, a
rotating four-horse fleet at one table, no phrase repeats until the voice is
spent and then the chooser returns null; every cell has at least 8 distinct
phrases; Dan's 23-minute case is reproduced through `speakAtTheFelt` and a
different line is said.
