# Horse request contents follow settled-hand retention

Owner direction: settled horse-only hand contents expire after eight days; human-hand history remains permanent.

Before: production sp_prune_hand_history deletes eligible history/atomic/index rows, while hand_submission_retention_disposal adds a compact disposal receipt. The original immutable request payload remains. The old receipt proves an atomic row existed but does not record completion of postcommit obligations.

Change: qualify request-only erasure to an empty JSON object after an exact matching retention disposal captures completed postcommit evidence. Identity, original digest, lease and disposal remain immutable. All other UPDATE/DELETE/TRUNCATE mutations still refuse. Reject human/unknown/young/reported/F06-held/unsettled tournament candidates. The existing retention path performs this erasure in its original transaction. An incomplete attached hand is retained before any existing history deletion.

No balances or money rows change. No scheduler, watcher or repeated repair job is added. Legacy receipts without completion proof stay retained; they cannot be represented as safely deleted. The comprehensive remaining-data/backlog/reclamation plan is docs/HORSE-HAND-RETENTION-PLAN.md.

Qualification: exact installed prune preimage captured read-only, original recorded disposal migrations exercised in native PostgreSQL17, candidate must demonstrate fail-before/pass-after plus replay/refusal/human/unknown/age/unfinished boundaries. Existing required CI carries the native harness. Actual evidence and installation are recorded in the task checkpoint separately.
