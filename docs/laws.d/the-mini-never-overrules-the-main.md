# server/src/engine/theMiniNeverOverrulesTheMain.law.test.ts

Dan signed off a second jackpot tier on 2026-09-07: a flat amount out of the
backup reserve when a hand comes close to the main bar and misses - hold'em
aces full or better losing, PLO any quads losing. The risk a looser rule beside
a stricter one creates is that it pays a hand the STRICT rule was meant to pay,
at a few hundred chips instead of a share of a six-figure pool. This pins both
halves of why it cannot: settlement may call the mini only where detectBBJHit
has already refused, and the mini's money may come only from `backup_balance`
through `fn_bbj_mini_payout`, never from the jackpot itself. It also pins the
gates the mini keeps (winner holds quads or better, the pot floor, the
players-dealt floor, variant eligibility, double-board exclusion) and the two it
deliberately drops (Ace in hand, both cards play), because those two are what
make it the near-miss catcher rather than a second main jackpot.

It also pins the mini's own counters: a mini is counted as a mini and never as
a main, so `detected == paid` keeps meaning what it means for each jackpot, and
a replay (`already_paid`) is not written down as a refusal.
