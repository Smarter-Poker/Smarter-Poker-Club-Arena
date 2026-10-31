# Original tournament hands survive engine loss

An October 28 engine interruption left reserved tournament hands without final
settlement. Existing generation recovery marked saved hands complete and dealt
new numbers from committed stacks. It could not continue the original deck or
prove a missing payout. A saved river in another tournament correctly refused
that discard, leaving its generation unable to admit any of its three tables.

The controller now retains its exact remaining deck, private cards, state machine,
runout and discard state. Its original F06 identity, original seat generations,
starting stacks, engine hand metadata and pending event batch travel together in
one private database record. Normal controller mutations persist before events
reach their existing consumers or HTTP action success reaches the caller. A
successor claims the same original under its current lease, replays its last
pending event batch and resumes the same hand. It does not allocate a new number,
post blinds again or recompute an already completed payout. Accepted atomic
settlement removes private continuation bytes in its own transaction.

Concurrent identical HTTP actions join the original reserved intent while its
write is pending. An unknown write reports an explicit pending outcome and cannot
become a successful acknowledgement or a second application. A stale owner or a
retained-hand safety deadline fences the owner without discarding its hand.

Time-bank events use stable original event receipt IDs. Retained allocations
resume their unspent time without charging another activation, and unresolved
bank debit requests keep their original IDs through recovery. Tournament breaks
and platform maintenance retain their own authorities.

Legacy snapshots contain no unused deck. Only the narrowly proved single-board,
unacted PLO5 tournament river can continue without one: PostgreSQL checks the
exact snapshot, original permit, public blind posts, complete board, unchanged
chairs and pre-hand stacks. It retains an empty unavailable deck and awaits the
remaining players' actual decisions. This path does not invent checks, cards,
winners or payouts. Earlier streets cannot use this exception.

Validation includes actual controller and actual engine-runner tests, exact-byte
codec and dispatch ordering checks, HTTP concurrent action tests, paid-clock
recovery, original F06 ownership, and native PostgreSQL financial settlement,
restart, permission, freeze, rollback and concurrent disposition tests. Delivery,
migration installation and natural live continuation are separate acceptance
steps recorded in the incident checkpoint.

Real-time law: original named hand and clock events use their existing discrete
WebSocket consumers after durable retention; no snapshot-diff animation is added.
