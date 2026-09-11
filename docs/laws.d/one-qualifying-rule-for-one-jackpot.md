# tests/one-qualifying-rule-for-one-jackpot.law.test.ts

The two copies of `BBJ_QUALIFYING_HANDS` - the engine's and the client's - must
be identical field for field, and every variant the platform spreads must have
its own entry. They drifted on `pineapple`, so the client showed the hold'em
bar on a variant the engine judged at Quad Kings, across four real hits.

It also pins `splitIfMultipleQualify` to what the engine does. The flag read
`true` in both halves and the rules page promised players that the prize is
divided between multiple qualifying losers; the engine has always paid the
single strongest qualifying losing hand. A flag a player-facing surface reads
must be a flag the engine obeys.
