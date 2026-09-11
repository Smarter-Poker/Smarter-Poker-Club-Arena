# A satellite never feeds a target its finish refuses

**Date:** 2026-09-11
**Migration:** `20260911110907_a_satellite_never_feeds_a_target_its_finish_refuses`
**Ruling:** `scripts/deploy/2026-09-11-settle-satellites-into-bounty-targets.sql`
(read-only checks beside it, `.checks.sql`)
**Incidents:** `Tournament.atomic_satellite_finish_refused`, one per satellite
into `e9541c66` / `8171f9f6`, resolved with their cause by the ruling

## What was wrong

From 03:01 UTC the heads-up satellite feeder opened "Sunday Funday High Roller
PKO Satellite Heads-Up" games into both Sunday Funday High Roller PKOs
(`e9541c66`, Midway Union; `8171f9f6`, Deep Stack Society). Each is two seats at
47.50 + 2.50 for one seat worth the target's 67.50 + 7.50 = 75.00 entry, and
35.00 of that entry is the PKO bounty. Every one was played to a winner and
then refused by the one satellite settlement authority:

    satellite <id> target <id> uses an unsupported bounty or Spin entry split

The refusal is right. `fn_settle_satellite_tournament` delivers a seat as one
prize-plus-fee transfer; it cannot book the 35.00 bounty slice onto the target's
bounty rail, and booking it as prize is what left the two 2026-09-07 PKOs with
bounty pools of 2310.00 and 5425.00 that held no money and paid none.

What was wrong is the feeder. `pickSatelliteTargets` chose the dearest open
events in the owner's scope and never read `is_bounty`, `is_pko`,
`is_mystery_bounty` or `is_premium_spin`, and the dearest weekly event is the
PKO, so it got a feeder every time the last one filled: 14 decided and stuck by
11:22 UTC, each retried every few seconds through the platform-wide settlement
lane, 1,500 critical alerts. Nothing at the database refused the insert either,
and the club Create Tournament modal offered bounty events as satellite targets
and would auto-generate satellites for a bounty main event.

## What changed

- **Engine.** `satelliteTargetIsDeliverable` is the authority's predicate in
  TypeScript (every flag a known `false`, never Spin, never a bounty variant);
  the feeder reads the flags and skips any target it refuses.
- **Database.** `fn_satellite_target_is_deliverable` and the trigger
  `satellite_feeds_only_a_deliverable_target` on `tournaments`: a satellite may
  not be inserted or re-pointed at a target the authority refuses, and a target
  live satellites feed may not take a bounty, PKO, mystery-bounty or Spin
  contract. Existing rows are untouched.
- **Client.** The satellite target picker lists only deliverable events, and a
  bounty or Spin main event does not offer "Generate Satellites".

## The ruling

Each decided satellite settles exactly as the authority settles a satellite
whose target cannot take the seat: the winner is paid the 75.00 entry at exact
price through `fn_credit_and_log`, the bubble the 20.00 remainder, 5.00 rake is
settled and attributed, escrow closes at zero, and the stored v2 receipt is the
one the engine's retry now receives. With `c_deliver_seats` the winner then
enters the PKO through the ordinary paid door, `fn_register_horse_for_tournament`:
32.50 to the prize pool, 35.00 to the bounty rail with the head seeded at 35.00,
7.50 fee. Every entrant was a horse and is treated exactly as a human would be.
Satellites that never started and hold no entrant are cancelled through the
atomic cancellation authority.

Rehearsed on a local PostgreSQL 17 copy of the live schema and the production
rows: 14 settled, 14 seated, 2 cancelled; every receipt verified by the
unchanged reader and by the engine's TypeScript verifier; the public door and
the resolver adopt every receipt; the PKOs' refund plans agree with escrow; a
new PKO satellite is refused.

## What is left

Delivering a real satellite seat into a bounty target (three funded rails and
the head seeded at the bounty slice) is a change to the settlement core, the
receipt reader, the seat-entitlement trigger and the cap-ticket redemption door,
and it belongs on top of the Phase 3 terminal bundle that pins those functions.
When it lands, the predicate above changes with it, in the same change.
