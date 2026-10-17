# The Horse League Completes Hands Like Production

- Production completes every hand's action stream into opponent memory after the last horse decision. The nightly
  self-play league did not, so the action that ends a hand (a river call, a fold to a bet) never reached league memory.
  Every fold and call counter missed its last entry, and the river fold rate was never readable in the league
  (0 of 159 reads in a 400-pair probe).
- The league now completes each hand the same way, under the hand's own read scope and with the same per-action keys
  the decisions used, so nothing is counted twice. In a 2,000-pair probe 641 of 818 river reads now return a rate.
- `v23_river_reads` still changes no decision in self-play: league horses fold rivers 43-88%, so the read only raises
  the bluff multiplier, which every consumer already caps. The matchup stays on the card as a record of that.
- Test: `HorseLeagueCompletesHands.test.ts` counts every river response in 300 dealt hands exactly (the old league
  counted 0 where the hands held 8). Full server suite and tsc pass.
