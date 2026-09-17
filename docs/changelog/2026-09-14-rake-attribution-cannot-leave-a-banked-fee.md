# Rake attribution cannot leave a banked fee behind

Received production-alert originals cover216 deadlocks,131 lock timeouts and
2 debugger-stack failures across349 tournaments. The current settlement
function can exhaust attribution retries, retain the bank credit and return
`ok:true, attributed:false`. It also reports a previously claimed incomplete
settlement as successful. Its main terminal caller separately checks stored
attribution; this change makes the rake authority itself uphold that boundary
for every caller.

Migration20260914223105 keeps four transient attempts and the same delay
schedule. Exhausted or permanent errors now escape with their original
SQLSTATE. An incomplete logical result raisesP0404. Fee credit, counters and
the new claim roll back together. Historical incomplete claims return a
refusal without alteration; complete replay returns its stored attribution.
Amounts, distribution formulas, Diamond custody, zero-member policy, lock
order and permissions are unchanged. No repair job or payment is added.

The single transaction pins the current definition, owner and ACL, verifies
its exact postimage and accepts exact replay. Unknown code or permission
drift is refused before replacement.

Local PostgreSQL17 qualification reproduces the old partial commit with a
real persistent row lock, then verifies real deadlock/released-timeout retries,
exhaustion rollback, permanent errors, logical refusal, historical replay,
outer rollback, service access and migration drift guards. Financial callees
are explicit transaction recorders. This is not full financial formula,
actual Diamond custody, native release or installation proof.

Read-only historical reconciliation found349 matching settlement amounts,
2128 matching player VIP-credit and rake-stat receipts, and3986 retained
commission receipts. Historical commission recipient/rate completeness and
117 nonzero hand-count receipts remain separate qualification gaps. No
historical record, original alert resolution or money changed. The original
deadlock, timeout and debugger initiation causes remain open. This candidate
hardens the demonstrated partial-commit mechanism; no incident is closed.
