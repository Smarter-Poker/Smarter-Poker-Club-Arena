# Native CPU evidence retains transient threads

The existing hosted Linux qualifier failed in PR4908 because one child thread
was present at the first heartbeat and absent at the terminal observation. Its
CPU comparison required every original thread to survive, even though the
original process leader remained and exact surviving thread identities showed
positive CPU at nice19. A thread endpoint observation is not lifetime accounting.

The maintained qualifier now reports a lower bound from exact TID/start-time
pairs, retains absent and new identities explicitly, and refuses a missing or
replaced original process leader and regressed comparable counters. All observed
priorities, positive comparable CPU, seeded parity, native readiness and actual
cleanup requirements remain. No CPU is inferred for vanished or newly observed
threads. The function remains inside the native fixture's existing whole-file source hash.

A regression uses the actual hosted failure's leader and missing-thread values,
plus TID reuse, replaced leader, regressed counters, duplicate identities and
zero-delta cases. The full original failed vector is retained in task evidence;
it fails on the old function and succeeds with explicit limits on the repair.
The existing GitHub Node22 Linux integration remains the native verification
path; this Mac does not provide that Linux execution environment. No application
runtime or production operation changes.
