# A bust the door placed is not a failed bust (2026-10-25)

## What Dan saw

Notifications, 17:55 Central: `Money Check Failed CRITICAL |
fn_ca_absent_tournament_players: 2 finding(s) on the ledger layer`.

## What was happening

Both findings were the two Sunday Funday PLO5 Mystery events (0fed81b3,
11b1db64; 195 and 193 entrants; chests-only mystery bounty, chests open at the
money). Busted players sat at 0 chips, no chair, still listed `playing`, with
their knockout candidate `pending` - up to 24 per event and 24 minutes old.

They were not stuck. Read from `tournament_knockout_candidates.resolved_at`
and the edge logs: every elimination admission for these events was exactly
`fn_tournament_has_unsettled_bounties` -> `fn_open_tournament_rebuy_decisions`
-> ONE `fn_claim_tournament_bounty_elimination` -> ONE `fn_collect_bounty`,
then a new admission. The two events alternated one bust every 10-35 s while
the field busted faster, so lag grew linearly from about 20 s at 22:02 UTC to
about 24 minutes at 22:52, then drained once the bust rate fell. Database
calls were fast (claim ~150 ms); the engine scheduler queue was empty.

## Root cause

Since 2026-10-22 the door places every pre-money bust of a chests-only
mystery event and writes no bounty obligation, answering
`bounty_blocked: mystery_bounties_start_in_the_money`. `eliminatePlayer`
treated that answer as a durable commit, but skipped `processBountyCollection`
only when the knocker was unattributable. For this new reason it went on to
collect, found no settled obligation (there is none by design), and returned
**false** for a bust that had already committed. The assignment pass reads
false as a refusal and ends, re-arming a 5 s retry - so a batch of up to 20
became a batch of one.

No money moved wrongly: `bounty_pool_paid` stayed 0 on both events and no
obligation or award was written. The busts were recorded late, not wrong.

## Fix

`server/src/tournament/TournamentManagerEliminations.ts`: the door's
`bounty_blocked` answer sets `doorWroteNoBountyObligation`, and the collection
block is skipped for it exactly as for an unattributable knocker.
`eliminatePlayer` now returns true for every bust the door placed, so the
pass records the whole batch.

Pinned by `tests/a-bust-the-door-placed-is-not-a-failed-bust.law.test.ts`;
the neighbouring `the-engine-asks-the-door-even-when-the-head-is-unattributable`
law now asserts the widened guard.

## Damage

None to settle. Both events' backlogs drained by 23:02 UTC (0 pending, the
money check returns no rows). The net (`fn_ca_absent_tournament_players`)
stays and should now find nothing for this cause.
