# Lightning settles raked hands with zero-contribution folders

The October 15 Lightning producer changed the rake envelope's player count to
all players dealt, while its contribution map still omitted zero payers. The
physical accepted-hand contract binds that count to the map's keys. A raked
hand with an early zero-contribution folder therefore returned
`physical_settlement_refused`, with native detail `post_commit_fee_mismatch`,
and rolled its settlement back whole. The previous regression replaced the
physical door with unconditional success and missed the producer/consumer
mismatch.

The forward migration includes every dealt player in the contribution map,
including zeros, matching the physical engine. It retains the dealt count and
filters promo playthrough to positive contributions. The existing weighted
allocator already excludes zero contributions. Fees, eligibility, distribution
weights and historical settled records remain unchanged. Exact preimage,
postimage, execution authority, maintenance boundary and security metadata are
asserted in one transaction. This is a database repair using the existing
engine API and needs no engine replacement.

The required accounting shard now runs a native PostgreSQL regression through
the real physical settlement path. It reproduces the exact refusal before the
migration, settles the same refused four-player/two-payer hand afterward,
checks the complete contribution map, positive-only promo, unchanged fees,
post-commit delivery, replay, conflicting requests, ACLs and migration replay
refusal. All existing 22 Phase 6 sections still execute.

The closed private Madness incident set contains 1,611 abandoned hands formed
from 2026-10-18 19:29:52.899Z through 22:20:58.359Z. Each has a recorded
zero-committed folder; none has a settlement/history receipt, atomic commit,
physical settlement, settlement idempotency key or held reservation. These
native abandoned hands remain void: the attempted settlement rolled back and
their stakes were not charged. No winner is reconstructed from absent result
payloads, no wallet correction is needed for the rolled-back transaction, and
none counts toward completed or qualified hands. The per-hand IDs, immutable
selection digest and per-player counts are retained in the task's private SSD
evidence. This decision does not alter their historical records.

Public rollout remains off. Madness stays paused until the exact migration is
installed/read back and the closed reconciliation is rechecked. Fresh actual
raked hands with zero contributors, post-commit delivery and replay must then
verify the repaired live path. Broader browser, latency, integrity and remaining
qualification gates retain their own outcomes.
