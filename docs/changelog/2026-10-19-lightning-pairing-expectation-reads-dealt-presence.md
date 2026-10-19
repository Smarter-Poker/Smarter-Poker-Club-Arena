# Lightning pairing expectation reads who was actually dealt

`fn_lightning_integrity_scan` decides PAIRING_CONCENTRATION by comparing how
often two players shared a hand with how often chance would seat them together.
Its chance figure sized the pool at each hand by counting open
`lightning_pool_session` rows, and treated a player as present whenever they
merely had an open session. An open session is not playability: a busted
anchor, a sitting-out player or a pending leave keeps one and is dealt nothing.
This is the same miscount already fixed for the population count
(2026-10-18-lightning-funded-eligible-population).

Measured on the private Action pilot: during the October 17-18 busted-horse
stall about 38 sessions were open while only 8-10 players were being dealt, so
chance was understated about fourfold and every pair of the few playable
players looked concentrated. The eight open high findings (12, 14, 38, 41, 49,
69, 77, 110) reproduce exactly under the old method (ratios 3.51-7.17).

The expectation now reads presence from the hands the Cluster dealt. The
window is cut into ten-minute strata; a player is present in a stratum when
dealt a hand in it, and a pair's expectation sums, over the strata where both
were dealt, A's hands times B's hands divided by the stratum's hands. On the
same production rows the eight findings measure 0.83-1.03, and no pair with 30
or more shared hands in any Action or Madness daily window since October 17
reaches the unchanged 2.0 floor (largest 1.63). Thresholds, scores, the other
five patterns, extend-never-duplicate, budgets, the advisory lock and the
CHIP_FLOW mirror are byte-identical; only the evidence `expectation` label and
`thresholds.pairing_expectation` now read `dealt_presence_10m`. No existing
finding is edited and no horse is treated differently (the scan reads no horse
flag).

Migration `20261019174213` applies exact substitutions to the exact production
preimage (md5 `342b9ff5...`), asserts owner, SECURITY DEFINER, volatility,
search path and grants unchanged, and pins the postimage `5454a367...` in its
`@live-proof`. The PostgreSQL 17 proof
`scripts/ci/test-lightning-pairing-expectation-reads-dealt-presence.py` (run
from the required accounting step) installs the production definition and
reproduces the stall: 40 open sessions, 8 playable, all 28 pairs flagged high.
After the migration the stall yields no pairing finding, while a pair that is
always seated together in a healthy 30-player pool is still flagged high
(ratio 4.4) and no random pair is. A second application is refused.
