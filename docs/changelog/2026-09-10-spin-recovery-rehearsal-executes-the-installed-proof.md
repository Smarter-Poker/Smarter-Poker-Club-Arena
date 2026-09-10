# The Spin Recovery Rehearsal Executes The Installed Proof

The existing Spin funding rehearsal supplied fixed answers for played-game
recovery. It could verify how the atomic draw responded to those answers, but
could not verify the installed proof that produced them.

The rehearsal now loads the installed SQL helper and checks its body hash.
It also checks the exact composed atomic function definition. A valid played
state and fourteen invalid evidence states exercise the real proof and atomic
replay, including unchanged-row checks when recovery is refused.

All 58 PostgreSQL checks passed. This is a test and audit evidence change.
It does not change production code or certify the separate hand, seat,
journal and escrow writers. Scope and remaining controls are recorded in
`docs/audits/2026-09-10-phase3-sng-spin-recovery-evidence.md`.
