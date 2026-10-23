# Lightning Cycle Witness Answers Client-Held Turns With Fold And Watch

Since #7738 a pilot horse account played by its own client keeps its turn, so the cycle witness proved the Time Bank live for the first time (run 39930382928: activated and deadline extended). It still ended unknown: as a passive client it timed out on every turn, left each hand at once, and never observed betting, showdown or history (4 hands, none qualifying). It also counted the app's own automatic Time Bank requests (8) as its one request.

On its own turn in the natural cycle the witness now takes the normal non-wager Fold & Watch, once per hand, and watches the hand to showdown. It never bets, calls or raises. It tries the pre-action first, while others act, and the Time Bank second. A Time Bank request made outside the witness's own click is retained as appRequests and is not counted as the witness's request. Qualification rules are unchanged.

Tooling only.
