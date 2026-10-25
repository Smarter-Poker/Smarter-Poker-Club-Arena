# A horse line is true of the hand it follows (2026-10-24)

Follow-up to `2026-10-24-a-table-never-hears-the-same-horse-line-twice.md`.

## Measured first

Production ledger, last 24 h before the fix (read-only query on
`horse_table_talk_ledger`): 861 of 4,712 horse lines (18%) repeated a phrase
already said at the same table. Worst: arrival 44%, big_hand_shown 30%,
big_pot_won 28%, showdown_loss 16%, the four one-line pools. The first PR
removes those repeats; re-running the same query after the 04:00 engine reset
is the live proof (expected: zero repeats for lines said after activation).

## The second tell

`big_pot_won` and `pot_won` fire for any pot the horse wins, called or not,
but several lines only make sense after a showdown: "somebody wanted to see my
cards", "curiosity is expensive", "ty for paying me off", "keep calling",
"knew you had nothing". Typed after a hand everyone folded, they read as a
script.

## The fix

- `TalkFacts.showdown` (not a placeholder): true when two or more hands reached
  the showdown. `detectEvents` sets it for `big_pot_won` and `pot_won`.
- `horseTableTalkLines.LINE_NEEDS` tags each line that needs a showdown, or
  needs everyone to have folded; `fitsTheHand` applies it inside `chooseLine`,
  together with the never-repeat rule. An event that does not say uses neither
  kind of tagged line.
- New fold-out lines so a won pot nobody called still has a deep pool in every
  voice ("thanks for folding", "smart fold", "phew, nobody called"...).

## Pinned

`HorseTableTalk.test.ts`, "a line is true of the hand it follows": every tag
names a real line in a won-pot event; every voice keeps at least 6 lines either
way; 300 hands x 3 horses per voice never cross the tag; `detectEvents` sets
the fact both ways. The no-repeat law now runs after a showdown and after a
fold.
