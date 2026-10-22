# Lightning pilots switch at six-seat pool math; a third browser actor

Owner approval (Dan, 2026-10-22): keep the two private six-seat Lightning pilots
running off-peak by sizing their ON/OFF threshold to six-seat pool math and
making sure players reach them; add one more private-pilot test player for live
browser verification. Public Lightning stays off. Only Lightning Pilot NLH Action 6
(`56d5d6f0-23e9-41b0-b407-852aa1026c2a`) and Lightning Pilot NLH Madness 6
(`681eb9e8-e9fd-4026-8ec6-64075b911d33`) in the private pilot club change.

## Measured

Distinct players seated in the cluster or in a live pool, 15-minute samples,
2026-10-19 04:00 to 2026-10-22 04:00 UTC:

|         | while the 72-horse assignment was active (Oct 19) | after each switch-on (Oct 20-21)                           | overnight since            |
| ------- | ------------------------------------------------- | ---------------------------------------------------------- | -------------------------- |
| Action  | 34-42                                             | exactly 18 for hours, decaying to 12, off 2026-10-21 23:13 | 6-9                        |
| Madness | 20-36                                             | 13-20, off 2026-10-20 22:37                                | 0-7, no pool for 30+ hours |

Every switch-on landed within minutes of 05:00 UTC, when the Chicago day rolls
the horses' daily caps over; every switch-off came as caps filled. At 05:29 UTC
on 2026-10-22 live-eligible was Action 15, Madness 5, both still in MUST-MOVE
because the default ON was 18.

## Threshold: ON 12 / OFF 8

`20261022052324_lightning_pilots_switch_at_six_seat_pool_math.sql` writes
`on_threshold` 12 and `off_threshold` 8 into exactly these two games'
`ruleset_snapshot.lightning`, preserving every other key (asserted byte for byte),
and reads back `fn_cash_cluster_lightning_thresholds` as `source: ruleset`.

- ON 12: two concurrent six-handed hands, so the matcher always has a second
  table to rotate folders into.
- OFF 8: one full six-handed hand plus fast-fold turnover before reverting.
- ON - OFF = 4: one table's churn cannot flap the cluster.

The measured overnight minimum is below that floor, so the lowest permitted pair
is chosen; going lower would make Lightning a single-table pool. The matcher's
pool bands follow (`fn_lightning_config`): thin 8, medium 12, large 24; thin and
tiny weigh diversity at zero by rule, so formation comes first. The operator door
has no threshold action, so a migration is the only audited route. The defaults
(18/12) and every other game are unchanged.

`scripts/dev/test-lightning-pilot-thresholds.sh`, chained from the six-seat boundary in the required matcher-parity native step (CI shard 3), builds the five
production reader functions byte for byte (md5) and the two pilot games verbatim,
proves the before image, refuses a drifted size, privacy flag, prior threshold,
changed reader or public Lightning with nothing changed, installs, proves 12/8,
bands 8/12/24, the floor, the live proofs, and refuses a replay.

## Routing

The horses are routed to the pilots through the existing owner-sanctioned path,
the pilot house board and the 72-player assignment (operation, manifest
`121f80d2...`). That assignment was released 2026-10-20 21:29; since then the
roster's horses spread across Midway Union and Diamond Arena tournaments and the
pilots fill only from whatever is idle. Re-asserting the assignment through
`lightning-pilot-assignment.yml` is the sanctioned lever, and it refused: on
2026-10-22 00:05 UTC historical-rakeback retention wrote 47 departed memberships
(status suspended, lifecycle departed, inactive, 22.67 chips in all, none of
them roster horses) into the pilot club, and the assignment's roster check
counted every membership row and demanded exactly 73.

`scripts/ops/lightning-pilot-assignment.mjs` now sets aside only rows of exactly
that departed shape that belong to no participant and not the owner; any other
extra or changed row is still roster drift. A regression fails before and passes
after. The assignment still moves nobody out of a running game or a paid
tournament entry, changes no cap, rest day or activity window, funds nothing and
asks no consent.

## Third browser actor

`milehigh` (`09dd202d-115b-49ae-afa8-cb528c7b8f72`) is an existing funded horse
from the exact 72-player roster (no new account): an active pilot member with
206 pilot chips, the largest balance on the roster, and no integrity finding of
any kind. Its daily counter had just reset (5 of 510 minutes played). It is pinned as
`THIRD_WITNESS_PLAYER` in `lightning-pilot-player.mjs`; `WITNESS_PLAYERS` (009,
Samantha, milehigh) is what the latency, financial and recovery witnesses accept.
It is not a consent player: `CONSENT_PLAYERS` stays 009 and Samantha, the only
two whose Terms/Privacy acceptance the owner authorized by name, and every mode
still requires the actor's own prior accepted Terms on its profile. Because the
owner has not authorized acceptance for anyone else and no roster horse other
than 009 and Samantha has accepted, milehigh cannot run a browser witness until
its own Terms are accepted under a separate owner authorization. The assignment
manifest is unchanged: milehigh is already in it.
