# An Expired Seat Is Not Reserved

A confirmed seat exit cleared the hero roster but retained the optimistic
pending-seat placeholder. The engine-seat reconciliation effect could then
restore heroSeat from the last pre-exit snapshot without restoring heroSeatRef.
The seat poll checked only that ref, so it could stop clearing the resurrected
claim. Together those paths rendered a zero-stack hero and Seat Reserved after
the seat had expired.

The existing removal callback now retires the optimistic seat, selected seat,
balance placeholder, and buy-in/rebuy presentation. Snapshot, bootstrap,
resync and engine-seat reconciliation respect the existing confirmed-exit
latch. The existing seat read also recognizes a claim in rendered state, and
reports read failures rather than silently dropping them. No new polling or
server/financial writes were added. A newly confirmed purchase retains its
existing latch reset.

The regression executes the actual route callbacks. It reproduces incomplete
removal and stale-snapshot resurrection before the fix, and preserves legitimate
funded and zero-stack waiting seats. Protected merge, publication and live
natural-expiry verification are separate evidence recorded in the task checkpoint.
