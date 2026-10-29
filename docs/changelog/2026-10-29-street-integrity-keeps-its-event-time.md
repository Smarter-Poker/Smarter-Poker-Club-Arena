# Street integrity retains its event-time state

Original hand continuation persists a synchronous controller mutation before
dispatching its events. A queued community-card event could therefore verify
the later showdown state after winners were credited. The retained pot was
added to the paid stacks again, producing false chip-creation alerts equal to
the pot (the observed 27,000 baseline plus 892 pot reported 27,892).

The existing verifier now measures synchronously on each original community-card
event before it enters the continuation queue. The event retains only its
verdict, hand number, stage, pot and measured totals. It carries no new player,
card, deck or RNG state. The queued handler consumes that original verdict
without measuring the later paid state again. Recovery-state transitions and
reporting run only after retention, including during original-event replay. The result stays
in the hashed private continuation and is absent from the public board frame. Older
version-one events without this optional field retain their existing reader;
the change does not invent historical snapshots or change payouts.

The regression drives the real controller through a hand, holds continuation
retention until after winner credit, and dispatches all three original streets
through the real engine/verifier. A real one-chip street defect remains
critical even if a later mutation cancels it before dispatch. The unchanged
case produces no false alert. No production hand or financial row was changed.
