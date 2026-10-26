# 2026-10-26 - Mystery bounty numbers agree; the ladder button opens Bounties

Audit of Dan's 5K GTD Sunday Funday Mystery screenshot: Rewards read
"Total Pool 5,375 / Claimed 1,250 / Still Available 4,125" while the Bounties
card read "Bounty Pool 4,525 / Awarded 1,330 / Still In Play 3,195".

Production (read-only): bounty_pool 4,525 = 181 entries x 25 (165 players + 16
rebuys); all 162 knocked-out rows still held their 25 head (a bust before the
money pays nothing and leaves it).

## Causes and fixes

1. `TournamentService` never selected `bounty_pool` / `bounty_pool_paid`, so
   Rewards always fell back to summing heads, and the realtime patch cannot fill
   it in (the publication does not carry `tournaments`). All three loaders now
   select both columns, so Rewards uses the funded pool the server maintains.
   The head fallback (events with no funded pool) now counts only players still
   in. This also stops the bounty half inflating Total Prize Pool.
2. "Open The Full Mystery Ladder" opened Rewards; it now opens Bounties.
3. A `?tab=bounties` link to a non-mystery event left no tab selected and the
   panel labelled by a tab that does not exist; `shownTab` makes the strip,
   roving focus and panel agree on Rewards. The tab is now read from `search`,
   which honours the in-table lobby's `searchOverride`.
4. A failed mystery refresh returned empty answers and blanked the ladder to
   "Loading" and "Nobody Has Won A Mystery Bounty Yet"; the live hook now reads
   strictly and keeps what is on screen.
5. The per-player payout card printed "Tournament Prize 0" on a failed read;
   it now says "Could Not Be Read", and the prize uses the event's money format.
6. The Revealed counter used the capped page length; it uses the server total.

Pinned by `tests/unit/theMysteryNumbersComeFromOneSource.test.ts`; the
discarded-error-read ratchet baseline for MysteryBountyPanel drops to 0.
