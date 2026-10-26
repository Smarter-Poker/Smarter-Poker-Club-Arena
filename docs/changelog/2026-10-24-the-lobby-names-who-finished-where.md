# 2026-10-24 - Rewards names who won each prize; Ranking says where each player busted

## Dan's ruling, verbatim

> "ON THE REWARDS PAGE, IT SHOULD SHOW THE PLAYERS AND WHAT POSITION THE BUSTED
> IN UNDER RANKING, AND WHAT PLAYERS WON WHAT PRIZES UNDER REWARDS"

## What was wrong

Measured on Friday Fight Night PKO (827A1B52), finished 08:46 UTC with all 276
finishing positions and 35 prizes recorded on `tournament_players`:

- **Rewards** printed "1st 17.32% 1,741" down to 35th with no player name on
  any row, even after the event ended.
- **Ranking** listed busted players as a faint "Finished 61st" beside a stack of
  "0 / 0 BB". The champion's status is `winner`, which `isPlayerOut` does not
  count as out, so the winner read "Not Seated Yet" beside an 18,175,000 stack
  nobody holds any more.

## What changed

- `RewardsTab.tsx`: every paid place carries the player who finished there and
  the prize actually recorded for them (a deal or the last place's residual
  makes it differ from the projection; the wallet holds the recorded one).
  Names fill in down the ladder as the field busts into the money. A band of
  places sharing one percentage ("4-6") opens into single places once anyone
  in it has finished.
- `RankingTab.tsx`: a busted row reads "Busted 61st" and shows what it won
  ("1,000 Won") where the stack used to read "0 / 0 BB"; an unpaid busted row
  shows no number. The champion reads "Winner" with their prize.

## Pinned by

`tests/unit/theLobbyNamesWhoFinishedWhere.test.tsx`; the "Finished 3rd"
expectation in `tests/unit/mttOverviewStructureFacts.test.tsx` now reads
"Busted 3rd".
