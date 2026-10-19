# Observe natural multirun hands in one foreground mobile page

Production proof 39278744529 passed all four baseline cases but failed natural
observer setup with no two-/three-run coverage. Its third and fourth cold pages
waited 13.068s and 11.099s for the shared account's native auth lock, rejected
with AbortError, and recovered transport only after the reconnect banner had
failed readiness. Those failures preceded cleanup. The journal does not prove
which native lock owner caused the wait. Earlier proof 39056430595 also exposed
background-tab frame sampling as a confound; the DOM mutation witness remains.

Six simultaneous observer subjects were a sampling strategy, not the delivery's
acceptance requirement. Use one foreground page instead. The subject must be an
eligible occupied, run-enabled cash table whose existing bounded 30-minute
history read contains both two-run and three-run hands on that same table.
Choose deterministically by the smaller run-count frequency, total frequency,
player count and table ID. Missing qualification fails explicitly; no fallback,
replacement or retry creates coverage.

The original cumulative 120-second setup and twenty-minute observation remain.
Initial protocol/surface/banner admission, strict media readiness and continuity,
actual pending rivers before every winner, every positive recipient landing
within 2px, both run counts, and exact before/after identities are unchanged.
Sampling breadth is reduced; this is not a product latency repair or evidence
that the required natural events will occur. Live proof is still required.

Focused regression results: before implementation, the six new chooser/singular
startup cases failed (new APIs absent) while 38 existing cases passed. After,
all 44 passed, including the unchanged river/recipient and DOM witness cases.
The singular initializer propagates failure without a second attempt and checks
all work against the same setup deadline.
