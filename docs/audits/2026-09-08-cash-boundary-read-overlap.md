# Cash hand boundary: overlap the move candidate read

The production leave_pending settlement step averaged 3,185ms in the
22:49 five-minute sample. It always awaited processLeavePending, then began
a separate fn_cash_seat_moves_pending read inside executePendingSeatMoves.
At 23:27, three read-only 47-byte table GETs from the engine host took
304ms, 726ms and 691ms. These small samples establish material round-trip
cost, not a complete capacity diagnosis or proof of a network-only cause.

The candidate list now loads concurrently with the existing leave sweep.
Promise.allSettled owns both outcomes and waits for both before retrying or
continuing. Cash-out execution still completes first; only then are the
announced candidates passed to the unchanged move RPC. A candidate includes
no amount. The database takes the authoritative stack under its existing
source seat lock, checks current move state, expiry and destination, and
refuses a departed source player. The caller still excludes unannounced moves.
There is no cross-hand cache, amount shortcut or new financial SQL.

A non-cluster table makes no candidate read. Idle-table behavior retains its
existing read and executor. A failed leave sweep never releases move execution.
Delayed leave refusal callbacks still check the requesting engine's authority.

Seven behavioral cases and the existing must-move and chip-continuity laws
pass (121 tests). They prove overlapping starts, the departure barrier, both
failure orderings, no cluster overhead, stale authority, unchanged execution
RPC, refusal handling, and announced-only filtering. Server TypeScript passes.
The production wrapper and underlying executor definitions were inspected
read-only. No production seat, cash-out or move was tested by mutation.

This saves one serial read on clustered cash boundaries; it does not establish
that the complete next-hand gap is two seconds. The live post-commit and
startup load investigation remains open, including tournaments.

## Earlier delivery proof

Warm entry PR #3895 merged as d5643ebb3991d266fa5cb675b3272edc97059776.
Both public and Hetzner origin served that exact SHA after publisher
34290891910, built 23:31:59 UTC. Its pre-push gate passed 2,975 tests plus
14 runbook checks. That client release requires no hourly engine restart.
The physical iPad home-screen flow remains unverified because the supported
browser connection cannot refresh its CDP tabs.
