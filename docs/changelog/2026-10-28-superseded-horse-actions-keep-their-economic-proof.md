# Superseded horse requests keep their economic proof without action copies

The billing investigation found old complete action arrays in retained cash
requests whose immutable disposal already says the table dealt past them. They
are outside the settled-hand payload compactor: that owner requires a different
`retention_pruned_settled_hand` receipt. This change qualifies only the redundant
action array of a receipted, never-accepted horse cash request. It never deletes a
submission, disposal, hand, settlement, balance, ledger, participant or financial
receipt, and does not change the owner's eight-day policy.

The reserved migration is
`20261028152912_superseded_horse_requests_retain_economics_without_action_co.sql`.
It requires the exact existing source definitions and owner/ACL authority. Its
qualifier refuses human/unknown/malformed original classification, a current
human or missing player, missing or contradictory receipt identity/digests/dates,
a non-later witness, recent requests, policy drift, current leases, any F06
permit, history/atomic acceptance, dispatch/handoff, reported hands, source
correction, retained restoration/custody and other named owners. Unknown inputs
remain whole.

Only `request.p_hand_row.actions` can change. Every other request field remains,
including all stacks, amounts, units, accepted facts, cards, timestamps, players
and original classification. The identity and original request hash do not
change. A closed private immutable certificate seals the original and compact
request hashes, action hash, original identity, disposal and financial DTO. The
unchanged original `signed_economics` reader returns exactly the same digest.
Compacted original/compact envelopes are refused before direct replay can reach
money code, and the current resume door still excludes the original disposal.

Storage savings are qualified using **actual compressed stored sizes**. An
initial logical-array bound avoids obviously unprofitable attempts. Each
qualified transition occurs inside a PostgreSQL subtransaction: certificate,
exact action removal, fresh stored-value read. If source bytes saved do not
exceed the exact certificate tuple plus 4 KiB of heap/index slack, dedicated
SQLSTATE `P5501` rolls back just that attempt. Unrelated errors propagate; no
retry, swallowed operational failure or scheduled repair is introduced. Native
PostgreSQL demonstrates why the fresh point read matters: `RETURNING
pg_column_size(request)` reported 72,980 bytes for a replacement that occupied
1,715 bytes when reread after storage compression.

The explicit owner-only function accepts at most 100 supplied UUIDs, skips locked
rows and stops starting work after a one-second soft budget. Callers retain
normal outer statement deadlines. Existing disposal owners pass only their own
new receipt's first five UUIDs through the indexed `receipt_id` lookup; they do
not scan historical requests from gameplay resume. A normal disposal before
eight days remains whole, so this is not a claim that all future aged/dormant
requests now drain automatically. No competing scheduler was added.

Two changed helpers are pinned by the existing 26-source correction matcher.
The migration advances only those two exact hashes, preserves every other pin
and owner/config/ACL, and leaves unrelated source drift refused. Live readback
before this change already returned false for that complete matcher. The
focused native world tests the **actual comparison over the two affected pins**
true before/after and false on a real source drift, plus identical other 24 pin
values. It does not manufacture a complete 26-source production certificate or
repair that separate pre-existing drift.

The maintained PostgreSQL 17 qualification executes captured current resume,
commit, retained-payload assertion, immutable trigger and economic reader. It
covers exact action-only changes, physical stored savings including the whole
initial certificate relation, semantically eligible but storage-negative
rollback, source/receipt preservation, idempotence, normal and malformed holds,
source matcher drift, actual public/private disposal hooks, permissions,
rollback and two-session SKIP LOCKED. A representative positive native request
occupied about 165 KiB before; its replacement plus the **entire** first
certificate relation occupied about 50 KiB. These are synthetic native fixture
bytes, not a production savings forecast. Production block samples contained
much smaller originals; no eligibility percentage or dollar reduction follows
from the native fixture.

The native runner is directly enforced in existing required Accounting shard
three. Input-only changes select that job; its artifact is retained. Protected
merge, installation, an explicit bounded production transition and affected
readback remain separate delivery steps. No production mutation, Realtime
shutdown, gateway activation, infrastructure resize or engine replacement was
performed during preparation. PostgreSQL row compaction does not shrink the
provisioned Supabase volume and does not prove a lower invoice. Aborted attempts
can leave reusable physical space until vacuum; no instantaneous file-shrink
claim is made.
