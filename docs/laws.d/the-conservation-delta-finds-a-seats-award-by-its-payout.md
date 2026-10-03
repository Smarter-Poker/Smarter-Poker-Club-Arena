# tests/the-conservation-delta-finds-a-seats-award-by-its-payout.law.test.ts

`fn_tournament_conservation_delta` joins every satellite award ON `a.payout_id = sp.id` (never by place, which a version-3 co-qualifier's NULL payout position breaks) and counts house-funded bubble protection (a `correction` leg into `prize_liability` paired one to one, per amount, with a `bubble_protection` payout) as funding, so an unredeemed ticket is never credited to its target and a funded bubble never reads as missing money.
