# Continue tournament consolidation after a committed table closure

A successful table break previously returned the same result as a completed balance check. If the operation finished inside its work budget, the manager advanced through the remaining stages and restarted the full sweep on the next admission, although more consolidation remained. A busy shared queue could delay that next useful move by minutes.

The owning balance stage now continues after an explicitly verified table closure and exact engine retirement, rereading tables, seats and roster reservations before each new plan. It uses only the current admitted work budget. An unknown or blocked result ends this continuation so normal recovery and bust processing remain reachable. The existing deadline, maintenance and lifecycle fences, financial receipts, global concurrency cap and scheduler fairness remain in force.

Regression coverage exercises the actual manager with successive fresh seat snapshots and exact retirement receipts, alongside blocked-roster prerequisite reachability and budget, stop, abort and maintenance boundaries. Before the repair, the two new progression cases failed. This source change does not itself certify production throughput or resolve the separate SNG initial connection failure.
