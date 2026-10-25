# Lightning: Why the Next Hand Waits, and the Two Causes Fixed Here

Owner goal: Lightning is fast-fold poker, "instant fold to next table", "wait 3 seconds for the 6th then deal with 5". Measured on production at 21:15 UTC (`lightning_hand_player.waited_ms` joined to `lightning_hand`, last 15 to 30 minutes): p50 about 3.0 s, p90 11.6 to 13.3 s, p99 about 420 s, 5.95 players per hand, 3.8% of hands five-handed.

## What `waited_ms` Measures

`fn_lightning_hand_player_records_its_wait` stores `formed_at - idle_since`. `idle_since` is set when the player's reservation is released (their fold, or the hand's settlement), so the player's own hand is never counted. Two artefacts remain:

- **Time spent playing in other pools.** A player seated in several Lightning pools is held in one (`MULTI_TABLE_LIMIT`, mobile limit 2) while two hands elsewhere are live, and that time counts as waiting in the third pool. 22 players sit in three or four pools; their p90 is 48 s (three pools) and 174 s (four), and they are the whole 420 s p99. Over 12 minutes of hands, 31% of all recorded wait time was time the player was busy in another pool. Without it the wait is p50 2.6 s, p90 7.7 s, p99 18 s.
- **The formation time is the engine's pass start.** `formed_at` is the engine's `p_now`; the database transaction starts 0.1 to 0.4 s later at p50 and 1.3 s at p90 (`cash_cluster_events.at - payload.at` on `matcher_pass`), rising with database load. The recorded wait understates the real one by that much.

## Where the Real Wait Comes From

- **The matcher is already at the frontier for the 5/6 rule.** A replay of one 24-player pool (734 waits) through an ideal event-driven matcher with the same rule (six forms at once, five after the fifth has waited 3 s) gave p50 2.49 s, p90 6.69 s, p99 10.76 s; the live legal waits were p50 2.23 s, p90 6.62 s, p99 10.32 s. A six-handed hand forms 61 ms (p50) after its sixth player is free.
- **The tail is the release rate.** The recorded passes are mostly `IN_HAND` (18 to 22 of 24 in a hand), `WAITING_FOR_PLAYERS` (one to four legal) and `GROUP_SIZING` (five legal inside their 3 s). A freed player waits for four or five more releases, and a 24-player pool releases about 0.8 players a second, so p90 is 7 to 10 s; 39 players give p90 6.0 s, 10 give 18 s and 7 give 30 s. Horses never fast-fold (no `fast` fold in the window): they fold in turn, under-the-gun at p50 6.3 s and the button at 15.6 s after formation, and a hand played out lasts about 40 s.
- `WAITING_FOR_BB` was never seen in steady state: 20261024195059 holds nobody in a settled pool.

## Fixed Here

1. **A player freed in another pool is matched at once (engine).** `MULTI_TABLE_LIMIT` players become legal when a hand of ANOTHER Cluster frees them, and that Cluster's worker was never told: it found out at its next pass interval (up to 1 s) or by chance. Hands whose last-ready player was freed elsewhere formed p50 0.30 s and p90 1.16 s after that release (0.06 s and 0.69 s otherwise); five-handed ones p50 1.18 s and p90 2.76 s. `LightningSupervisor.peerReleased` now asks every other worker that held somebody for the limit on its last pass and has seen the player for a pass within the admission window (`LightningClusterWorker.peerReleased`). Nothing about who is matched changes.
2. **A seat the conversion made is not a newcomer, and a newcomer is the next big blind (migration 20261024213844).** Pool slots belong to an epoch, so right after a conversion every slot has `last_bb_at` NULL and every seated player counted as a newcomer: the 20261024195059 hold kept players who were already at the tables, and a player who really did just buy in sat behind every never-the-big-blind conversion seat in the blind order (the debt-age tie-break favours the older slot), held pass after pass. A conversion seat (cash session opened before the epoch began, pool session and slot entered within five seconds of it; production's conversions open every slot within 1.4 s) is no longer a newcomer, in `fn_lightning_blind_order`, `fn_lightning_match_plan` and `fn_lightning_matcher_snapshot`, the same expression in all three; and `fn_lightning_blind_order` ranks a newcomer first after an unresolved obligation, so a player who just bought in is still always the big blind first, on the next hand. In a settled pool the order is exactly the old one. The TypeScript port (`isLightningNewcomer`, `compareBlindOrder`) reads the snapshot's `newcomer` and still requires `lastBbAtMs === null`, so the flag can only exempt.

## Proof

- A rolled-back probe on production (one `DO` block ending in `RAISE EXCEPTION`, `REPEATABLE READ`) built the three replaced definitions as `pg_temp` functions from the live text and ran them beside the live ones for all 17 Lightning Clusters: 17 of 17 plans, blind orders and snapshots identical (no slot in any live pool is a never-the-big-blind seat today), 377 diagnosed players.
- The simulator's first 40 hands after a 24-player conversion (20 seeds): wait p95 7.2 s to 6.4 s, p99 13.5 s to 11.1 s; no change in steady state.
- `server/src/lightning/ALightningConversionSeatIsNotANewcomer.law.test.ts` (laws.d entry), the updated `ANewPlayersFirstLightningHandIsTheBigBlind.law.test.ts`, worker tests for `peerReleased`, and `scripts/dev/test-lightning-matcher-parity.sh`, which installs this migration after 20261024195059, refreshes every fixture's `newcomer` from the real snapshot and adds section 13, a fresh conversion with two later buy-ins.

## Expected Effect

The matcher change alters nothing in a settled pool, so steady-state waits are unchanged by it; it removes the slow first minutes after each conversion. The cross-pool pass trims about 0.5 to 1 s from the roughly 11% of six-handed hands (and about half the five-handed ones) completed by a player freed elsewhere, which moves the overall p90 by an estimated 0.1 to 0.3 s. A materially lower p90 needs more releases per second per pool, not a different matcher: larger pools, fewer pools per horse than its multi-table limit, horses using the fast fold a human has, or a faster engine-to-database pass. Those are owner decisions and are not made here.

## Delivery

The migration applies through the normal Apply Merged Migration path. The engine changes (`LightningClusterWorker.ts`, `LightningSupervisor.ts`, `LightningMatcherModel.ts`, `LightningShadowRunner.ts`, `LightningMatcherSim.ts`) ship with the next daily 04:00 America/Chicago engine release. Until then the live SQL plan applies the new rule and the shadow's `m1-port` runs the previous one, so an A/A calibration gap is possible only in the first minutes after a conversion in that window.
