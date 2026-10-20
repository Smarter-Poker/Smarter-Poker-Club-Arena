# Rebuy recovery across game types and currencies

The original custody proof is shared by every tournament game type. Expand its existing required native PostgreSQL check to execute the exact installed successor for NLH, PLO4, PLO5, PLO6, PLO8, Short Deck and OFC Pineapple, Fixed Limit Hold’em, Fixed Limit Omaha Hi-Lo and Pineapple, with rebuy and re-entry in both chip and Diamond fixtures (40 combinations). Each proves the complete original roster and purchase receipts. Retain fail-before/pass-after, both currency boundaries, duplicate reads and ACL refusals.

This change adds qualification coverage only. It does not change game rules, enable an unsupported tournament format, replay purchases or add a repair job. Production census found no active never-dealt rebuy block after the original migration; separately observed sealed-hand eliminations require their own evidence and are not certified by this read-helper test.

Runner-only and fixture-only changes now select the required PostgreSQL accounting job. Before this change both returned server=false, so the native tests could be edited without executing them. A regression pins the driver, whole fixture directory and source guard.

The matrix includes all nine maintained engine variants plus the historical OFC Pineapple tournament label. The source guard compares the engine variant list against the matrix, so adding a variant requires explicit recovery coverage.

## A movement admission gives its blocking bust the earlier stage

The fleet scan found today's Diamond Coffee Break with 376 zero-stack playing registrations and sealed-hand movement refusals. Break preparation already returns the cursor to elimination when it sees that roster mismatch. Movement-only startup can meet the same refusal before preparation is reachable, while its stopped dealer cannot emit another hand-complete wake. That admission path previously threw without asking for the earlier stage.

For the two exact SQLSTATE 55000 elimination/whole-roster refusals, read at most one zero-stack playing registration on the exact tournament and source table. Current authoritative evidence gives the existing elimination stage its next admission; retain the original movement refusal, operation identity and all financial checks. Unknown reads, changed ownership, other errors and an empty result cannot rewind. No new repair loop, payment, seat adjustment or forced engine restart is added.

Both positive regressions failed before the source fix and pass after it. Connected original-manager and refused-proof tests also pass. This reproduces and fixes the connected wiring gap; the old manager's retained logs were unavailable after an unrelated container cutover, so the tests do not establish that this was its sole blocker. Its backlog cleared naturally under the earlier engine before that cutover. Engine delivery and live proof are required for this source change separately from the already installed database fix.

## Issued-chip estimates include both funding currencies

Today's Diamond event had 523 entry receipts and 244 Diamond rebuy receipts, while the chip-wallet rebuy count was zero. The blind-supply estimate therefore omitted the 732,000 chips those rebuys actually granted after a manager restart. Read rebuy/re-entry and add-on counts from the shared immutable funding receipts alongside retained legacy chip-wallet evidence. Take the larger matching count, never their sum, so one purchase represented by both records counts once. Preserve high-water marks on failed or smaller reads. All five independent reads share one round trip. No blind-cap rule, price, wallet, payout or player stack is changed.

The actual count consumer fails before (0 instead of 244) and passes after; tests retain legacy chip counts, avoid duplicate receipt/wallet counting, cover unknown evidence and preserve the concurrent-read bound.
