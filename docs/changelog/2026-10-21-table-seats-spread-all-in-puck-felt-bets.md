# Table Seats Spread Out, All In Puck, Bets On The Felt

Dan, October 21, 2026, with two phone screenshots of a nine-handed tournament:

1. "When a player is all in and they are on the right side, their tag above their head is blocked by the player above them. Spread the players out so they are spread around the table equally and not on top of each other. Make sure that any and all actions are fully displayed and not blocked. When a player is all in their chips need to be on the table and an ALL IN button should appear in front of that user (like a dealer button, but for all ins) as well as it appearing above their head. A FOLD should never block out another user's info, and the bounty amount needs to be fully displayed."
2. "Adjust the players chip position on the table. Make sure when chips are put in the pot they are actually on the table, and not on the rail. atl_mike chips are on the table, they need to be farther in."

## Root Causes

- Every phone seat was a vertical tower: bounty pill (-56px), action tag (-26px), avatar, plate, and an ALL IN badge hanging 22px below the plate. On a side column the tower was taller than the gap between chairs, so the corner player's tag and bounty printed over the plate above, and an all-in player's lower badge printed over the next player's bounty and tag.
- Top diagonal chairs were pushed to x 15/85 on phones, the same column as the side pods, so a top player's plate landed on the high side player's tag and bounty. In tournaments those pods are full size and their tags were also cut off above the head.
- The phone wager placer chose wager CENTRES on a band 3px inside the felt window, so the disc and amount label hung half over the rail, and it preferred that outermost band.
- The hero's bounty sat in the same lane the hero's bet chips are lifted into.

## What Changed

- `SeatSlot.css`: the bounty pill is pinned to the avatar's top-left corner (unused by the position chip and the card fan), so it adds no height and nothing can cover it. The below-plate `.seat__allin-badge` is retired. On phones shorter than 760px the action tag overlaps the avatar crown (-12px) instead of floating a full pod above it. Every top-cap chair (`seat-wrapper--cap`, tournaments included) keeps its tag below the plate on phones. Below 620px of height villain avatars use the compact 40px size.
- `SeatSlot.tsx`: ALL IN shows above the head for the whole time a player is all in, and a red ALL IN puck the size of the dealer button sits in the player's wager slot on the felt, beside the chips. It is outside ChipPhysics, so the street collect flies the chips to the pot and leaves the puck in front of the player.
- `tableGeometry.ts` `fitSeatToViewport`: top diagonal chairs keep their ring x on phones (and stay inboard of the side columns); the lower side chair is lifted 4 points on phones to even the side column. On the smallest felts (narrower than 290px or shorter than 400px, an iPhone SE) the original outboard lanes stay, because nine simultaneous wagers only fit there. Desktop is unchanged.
- `useProtectedCardLayout.ts`: wagers are first placed where the whole stack (disc, amount and puck) is on the painted felt with daylight, searched up to 100px deep; bounties are obstacles. Only when every wager cannot fit on the felt together does it fall back to the rail-band slots it always offered, then a wider set, then each wager's best clear spot in turn (`greedyProtectedWagers`). A wager never lands on a player, the board or the pot.

## Verification

Real components rendered headless (the `portraitRailScene` fixture, extended with tournament mode, bounties, folds and three simultaneous all-ins) at 320x568, 375x667, 390x700, 393x740, 393x852, 414x736, 430x800 and 430x932, six to nine handed, cash and tournament. Before: 10 to 26 cross-seat overlaps per configuration (tag over plate, bounty over plate, bet over hero bounty). After: zero overlaps between any two seats' plate, avatar, tag, bounty, position chip or wager, and no wager over the board, pot or a player at every size from 375px up. At 320x568 (iPhone SE, first generation) the side columns still touch, as they did before (26 overlaps before, 14 after). The `table-proportions` occupied-ring guard (320 to 480px, six and nine handed, every jackpot state) and `top-rail-seat` pass locally. Geometry suites (`chipRail`, `dealerButtonBelongsToItsSeat`, `SeatViewportReadability`, `tourneyUxSweep20260825`) pass; the bounty layout tests were updated in this commit to the new placement.
