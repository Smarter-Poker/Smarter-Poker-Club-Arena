# 2026-10-05 - Mystery bounty: the field is the entries, a played bust is not a chest, a flat head has no rank

Engine only (`server/**`). Three defects found by the mystery bounty audit at 455ec7ee.

## 1. `percent_field` activation could never fire

`maybeActivateMysteryBounty` passed `totalEntries: Number(fresh.current_players)`.
`tournaments.current_players` is drained to the players still in, so "open at the
last N% of the field" compared the survivors with N% of the survivors - never true
for N < 100. `mysteryActivationMayOpenOnBust` had the same read.

Fix: `readMysteryTotalEntries` counts the entry rows plus their `rebuys` (both a
rebuy and a re-entry increment `rebuys` on the one row a player holds), paged and
checked against the exact count. It is read once after entry closes and cached
(`mysteryTotalEntries`); unreadable waits for the next sweep. Pure counter:
`totalEntriesFromRows`.

## 2. False "Top Mystery Bounty" celebration on every pre-phase knockout

`bounty_collected` carried a `prizeRank` computed by ranking the flat pre-phase
head against a ladder of flat heads - rank 1 every time. The rank and
`preMysteryPrizeRank` are removed; only the chest reveal carries a rank. The client
half (the celebration no longer treats `mystery_pre` as a pull) ships separately.

## 3. Void chests handed to the champion

A bust already played (knockout candidate `pending`) but still recorded as playing
is paid flat from the regular half (20260911094503), yet it was counted in the
players remaining, so one chest per such bust was built that no knockout could draw,
and the terminal settle gave them to the champion (b5102d84). The draw count and the
seed's `p_players_remaining` are now net of `readUnrecordedKnockoutCount`;
unreadable waits.

Tests: `MysteryActivationCutoff.test.ts` (five new cases),
`mysteryBountyActivation.test.ts` (`totalEntriesFromRows`),
`flatHeadHasNoPrizeRank.test.ts`. No cron, sweep or repair path added.
