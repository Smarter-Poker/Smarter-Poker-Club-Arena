# Current hand settlement audit and release evidence

The public engine reported version 146e19a7, running=true. Git ancestry verifies that it includes cashout barrier PR #3727 and horse receipt PR #3737 (ed33eec88ca8d5e6557fb3443332a89c64968b8d).

Rebuy PR #3766's CI failed because its schema snapshot omitted the already-applied private core. Fresh production catalog reads verified wrapper hash 2a05339c9329ce9fcbefbc1ab72901f5 and owner-only core hash 7b987a8d9bc21645b5bf7ba1bde36f85. Commit 487c1a8d6 records the verified core in the schema fragment; the migration gate passes locally. No migration was reapplied.

Current main uses fn_ca_commit_hand_settlement with lease generations and a post-commit obligation envelope. The unpublished alternative cash-hand candidate must not be layered over it. Live catalog reads confirm three public overloads, all service-only: 9-argument b0599ac041b35cbf7e340ad2c5ed1265, 11-argument 42cd051b5f7014da40a80590deebd4fa, 12-argument 2b5d9b337c653f0430910334d7e21521. Both underlying cores deny anon, authenticated and service_role direct execution.

PR #3799 closes two reproduced caller gaps: the retry request aliased mutable engine state, and a valid receipt UUID for a different requested hand was accepted. The corrected writer snapshots the full request and verifies requested identity. Two before-tests fail, then all 40 hand-history tests, 19 lease tests, server TypeScript and 2,241 normal related pre-push tests pass. PR #3799 merged as af943dde50f2cc4003cb7355e167c7a5983d1452. Engine adoption for this PR remains unverified.

Crash recovery remains open in current source. ServerTableEngineBase.checkCrashRecovery restores disconnect state, marks an interrupted snapshot complete and starts fresh without reconstructing HandController. ServerTableEngineSettlement calls completeHandSnapshot before capturing final rake/BBJ and before the authoritative commit. Atomicity of an accepted transaction does not by itself recover an interrupted uncommitted hand. A watcher, guessed balance adjustment or another in-memory queue would not fix this lifecycle gap; none was added.

The broader tournament, cashier, BBJ, rake-distribution and diamond audit and historical incident provenance are not globally certified by these scoped fixes.
