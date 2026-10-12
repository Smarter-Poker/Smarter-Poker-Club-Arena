# Horse request contents follow settled-hand retention

Owner direction: settled horse-only hand contents expire after eight days; human-hand history remains permanent.

Before: production sp_prune_hand_history deletes eligible history/atomic/index rows, while hand_submission_retention_disposal adds a compact disposal receipt. The original immutable request payload remains. The old receipt proves an atomic row existed but does not record completion of postcommit obligations.

Change: qualify request-only erasure to an empty JSON object after an exact matching retention disposal captures completed postcommit evidence. Identity, original digest, lease and disposal remain immutable. All other UPDATE/DELETE/TRUNCATE mutations still refuse. Reject human/unknown/young/reported/F06-held/unsettled tournament candidates. The existing retention path performs this erasure in its original transaction. An incomplete attached hand is retained before any existing history deletion.

No balances or money rows change. No scheduler, watcher or repeated repair job is added. Legacy receipts without completion proof stay retained; they cannot be represented as safely deleted. The comprehensive remaining-data/backlog/reclamation plan is docs/HORSE-HAND-RETENTION-PLAN.md.

Qualification: exact installed prune preimage captured read-only, original recorded disposal migrations exercised in native PostgreSQL17, candidate must demonstrate fail-before/pass-after plus replay/refusal/human/unknown/age/unfinished boundaries. Existing required CI carries the native harness. Actual evidence and installation are recorded in the task checkpoint separately.

A qualified follow-up bounds each candidate iteration to250. The first scheduled5000-row batch took58seconds; the bound preserves the original20second work budget and all eligibility guards. Native qualification of both installed migrations passes30assertions. A production call still requesting5000 completed in about21seconds and pruned1500eligible rows through the capped iterations.

Classification follow-up: the original controller can omit has_human when it has no dealt roster. A current horse profile cannot establish who was human when that older hand was dealt. The successor requires explicit original JSON boolean false and explicit history false, preserving all prior settlement and retention guards. Native qualification reproduces the missing-classification erasure before the correction and retains missing/null/string/human evidence afterward. The three-migration harness passes37assertions; owners, grants, security mode and search paths remain unchanged.

Installed classification history version is20261012161152; the settlement-key history version is20261012161313. Recorded SQL bytes match the qualified sources. An attempted classification installation first timed out in Supabase history initialization while an independent logical export held the history-table lock; no migration body ran. Installation succeeded once that lock released. A brief retention-job safety hold was restored immediately after exact classification readback; the original command and schedule are unchanged.

Legacy qualification was withdrawn before installation: accepted F06 permits require a completed timestamp but do not enforce a successful postcommit result. Accepted permits alone therefore cannot certify old disposed requests whose atomic success evidence was removed. Those payloads remain protected, and the actual failed-result acceptance counterexample is retained in the native harness. No speculative legacy deletion authority is delivered.
