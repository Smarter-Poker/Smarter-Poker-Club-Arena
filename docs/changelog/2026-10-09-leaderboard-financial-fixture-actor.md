# Financial Qualification Fixtures Keep Their Synthetic Journal Actor

The restored schema's unchanged autoledger trigger records auth.uid() and its fallback identity references auth.users. Financial fixtures cleared their JWT subject when entering service_role, so valid writes would fail the journal foreign key before reaching the leaderboard assertions.

Every service-role financial fixture session now identifies the existing synthetic actor in both JSON and legacy claims. Anonymous refusal cases keep their empty identity. Database roles, production guards, financial assertions, transaction boundaries and frozen migration/postimage inputs stay intact; reviewed fixture and adapter pins are refreshed together. A maintained source regression checks all seven writer inputs and the anonymous boundary.

Actual socket-only PostgreSQL 17.11 mechanism proof with the unchanged production autoledger function: empty service identity fails 23503, existing synthetic actor succeeds, unknown actor still fails 23503, and exactly one journal entry records the synthetic actor. Own cluster stopped and scratch removed. This is mechanism proof, not full financial qualification; the maintained fresh-restore modes remain required.
