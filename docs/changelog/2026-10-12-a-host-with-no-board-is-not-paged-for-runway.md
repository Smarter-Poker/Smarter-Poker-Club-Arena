# A Host With No Board Is Not Paged For Runway

2026-10-12, swarm lane "banks". Closes the critical alert 9a65d5ae (incident 9275eb6b).

## What Paged

At 04:21 UTC the engine raised a critical alert: "The bank that funds guarantees for host 2a1132b9 (Deep Stack Society) holds 0 chips in clubs.chip_treasury, which is 0.0 days of the board's own 1500 a day. Refill it before an event refuses to start."

## What Was Actually True

- Deep Stack Society has no guaranteed board. Every one of its schedules has been inactive since 2026-10-04, it has no open or upcoming event, and its last Free Buy ran on 2026-10-05. It sits in FREE_BUY_HELD_HOSTS, the list of hosts the Free Buy board is not published for.
- Its bank is empty on purpose. Migration 20261012040553 (Dan's decision of 2026-10-11, Deep Stack Society joins Midway Union at 12 PM Central on 2026-10-12) moved the club's jackpot pool, promo float, spin reserve, agent and member wallets into the club bank and then the whole bank, 4,202,578.94 chips, into the Midway Union bank at 04:06:31 UTC, one recorded union_settlement leg. Nothing was lost and nothing needs refilling.
- No event can refuse to start for lack of that bank, because there is no event.

## The Cause

StableHandExecutor.checkBanks measured every host on the floor against dailyGuaranteePerHost(), the Free Buy board's 1,500 a day for a host it publishes for. A held host owes the board nothing, but was measured as if it did.

## The Fix

- FreeBuy.ts: dailyGuaranteeForHost(hostId) returns the board's daily guarantee for a host in FREE_BUY_HOSTS and 0 for any other host.
- StableHandExecutor.checkBanks reads that per host. A host that owes nothing has no runway to run out of and is never paged. Midway Union, which the board is published for, is still measured against 1,500 a day and still paged on an empty bank.
- Law: server/src/services/aHostTheBoardDoesNotPublishForIsNotPagedForRunway.law.test.ts.

No money moves. Horses and humans are treated alike: the rule is about which host owes a board, not about who plays on it.
