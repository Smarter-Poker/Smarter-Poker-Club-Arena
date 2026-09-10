# Heads-Up Seat Funding Rehearsal

Run `python3 scripts/dev/probe-tournament-registration-funding-pg17.py --heads-up-only`.
The default registration funding runner also executes these cases, so the existing
chip journal CI rehearsal calls them. Set `PGNODE` to the existing Node executable
to use the repository's pinned pg client instead of psql.

The runner creates a private PostgreSQL 17 cluster with TCP disabled, supplies
only its generated Unix socket, accepts no database URL, and stops and removes
the cluster even after a failed assertion. Catalog captures contain schema and
function definitions only. Test users, wallets and events are synthetic.

The fixture composes the existing registration and refund financial writers with
the captured public two-argument take-seat RPC, lease-bound launch owners,
94 installed financial and seat proof triggers, and 120 function body witnesses.
It retains the positive funded stack guard, journal key ownership, escrow and
entitlement writes, deferred roster proof, parent locks, live seat uniqueness,
actual-start refund constraint, readiness guard and immutable launch receipt.
Catalog definitions are installed unchanged; hashes and installed trigger
definitions are checked inside each case. Launch receipt defaults and nullability
are restored from the catalog, including its non-null random lease generation.

Sixteen groups cover sequential and overlapping same/changed-seat retries;
NLH/PLO4 with 300/1000 chips; two contenders for the last place; actual last-seat,
launch and refund lock races; exact refund replay and seat revival; and failures
after the paid seat, final refund receipt and final launch receipt writes.
Concurrency waits are observed through PostgreSQL lock activity while the first
real RPC transaction remains open. No deeper lock is manufactured before an RPC.
Replay and rollback snapshots compare every public table in the fixture, including
escrow journals and alert/support records, rather than just selected balances.

Spendable wallet chips plus tournament escrow remain exactly 2,000. Funded entry
components are 190 prize plus 10 fee (the Heads-Up 5% fee limit), independently
verified against journal debit/refund totals and wallet receipts. Tournament
stacks of 300 or 1,000 are separately proved in seats and roster. Heads-Up writes
no Spin draw. Readiness alone leaves the event refundable until actual launch.

## Limits

This is a bounded database rehearsal, not a full production schema clone or
end-to-end player certification. Auth/session verification is synthetic and RLS,
HTTP grants, UI, engine processes, dealer execution, live maintenance transitions,
Union accounting, Diamonds, guarantee overlays and historical records are not
exercised. Operational support tables are empty catalog-shaped fixtures. Their
foreign keys and triggers are not cloned. Notification/realtime delivery is
captured locally, not delivered. The full trigger inventory records which
triggers were imported; reporting, missions, membership management and
nonapplicable cash/Diamond paths are outside this fixture.

No production function, schema, wallet or historical payment is changed.
