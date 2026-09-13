# Atomic accepted-hand source verification

A committed `hand_history` row alone does not prove that the full accepted-hand
transaction committed. Older writers could record history separately from
stacks. The observation reader now requires the independent `hand_atomic_commits`
receipt, matching hand UUID, table UUID and global hand number for every bounded
candidate. A missing or mismatched receipt refuses the entire requested window;
the reader never returns only the verified subset as if nothing were missing.

The RPC remains a service-only, read-only STABLE statement. It uses the existing
unique receipt lookup and adds no hot-table index, trigger, foreign key or money
write. All prior actor, interval, row, action and byte bounds remain. The returned
hand carries only receipt identity and payload hash in addition to the existing
allowlisted public actions. The client verifies that envelope and binds those
receipt fields into the source digest. Receipt metadata is not added to opponent
model observations or exposed through worker health.

The source explicitly declares `atomic_hand_receipts` acceptance. An older source
envelope is refused, and new journal preparation requires this declaration.
Previously prepared durable payloads remain recoverable under the existing
immutable journal protocol; no stored batch is rewritten or guessed backfilled.

The interval still refers to history-row time. Neither this receipt check nor
`hand_atomic_commits.committed_at` is a completeness watermark: the latter is
written before transaction commit, and commit order can differ from timestamp
or global-hand-number order. Late commits, retention loss and discovery gaps
remain explicit. This fixes source acceptance, not durable discovery or model
window completeness.

Native fixtures reproduce history-only acceptance before the change and whole
window refusal after it. They cover missing receipts, wrong table/number, exact
identity, budgets, timestamp ties, a concurrent late commit and real completed
controller observations. The combined journal fixture also preserves fresh
process recovery, immutable retries, retention and actual isolated worker HTTP
transport. Fixture receipt rows model the accepted-hand contract; they do not
claim to execute production financial settlement. Both private databases are
stopped and removed after verification.

Compilation and228focused checks passed. The independent source fixture passed
9groups and the integrated journal/worker fixture passed29groups, both with
verified cleanup. Full runtime regression passed11,562tests across786files,
with145existing skipped tests and one skipped file (84.90s).

Migration20260913195856 was applied once at20:05:28UTC under database history 20260913200528. The exact function body999010570d68de2ed7af400a6e1ab0d5, STABLE
invoker mode and service-only grants match. A bounded native production read
returned12hands/73actions with12matching receipts in105.802ms. This verifies
the SQL path; it is not production PostgREST or capacity certification.

A final test-only case additionally verifies that new legacy preparation is
refused while an already prepared payload can still replay. The final focused
run passed229checks (47journal tests); the full runtime run above had46journal
tests. One invocation from the repository root was refused by the server test
runner's directory guard before running tests, then passed from the required
server directory. The guard and all timing limits remain unchanged.
