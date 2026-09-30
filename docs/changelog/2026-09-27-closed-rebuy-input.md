# The input device reads the closed tournament window once

The tournament manager tried a separate purchase for every horse in its bust
batch even when the database had finalized the event's rebuy window. Each
purchase enters the canonical settlement lane and receipt/seat authority path
before refusing a new purchase. A selected production refusal held that lane
until an ordinary elimination acquired it after 7.875 seconds. This is evidence
of contention, not proof that every remaining tournament stall has this cause.

The input device now reads `fn_ca_tournament_rebuy_window` once per invocation.
Only its explicit `open: false` with one of its two maintained closed reasons
avoids new purchase attempts. Open, malformed or errored reads retain the
original purchase path. No local level/window formula, persistent cache,
additional schedule, horse earnings exclusion or database mutation is added.

The caller still reads durable per-player decisions and uses the same atomic
elimination receipt checks, global bust ordering, finishing positions and payout
rules. The early return does not mark anyone answered, eliminated or repurchased.
The new await rechecks the existing mutation authority before proceeding.
Maintenance still refuses work before the first read. A policy closing after
an open read remains subject to the purchase door's fresh locked checks.

Regression tests invoke the actual manager method with isolated transport.
The unchanged source reproduced 20 rejected purchases for a closed 20-player
batch; the correction reads policy once without querying individual horses.
MTT, Spin and SNG, open/unknown/error results, re-entry, authority loss,
maintenance and a later closed batch are covered. No live purchase was invoked.
The production read on September 27 at 17:34:42 UTC returned closed for c775.
Deployment and actual backlog recovery remain separate required evidence.
