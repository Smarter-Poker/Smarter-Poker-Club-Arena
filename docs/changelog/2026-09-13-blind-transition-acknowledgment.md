# Blind transitions retain their intended level until acknowledgment

A failed table-blind write or tournament-level write previously still advanced
the manager, announced success and armed the next level. An overlapping call
could advance again while the first write was pending. Four runtime regressions
reproduced these failures, including a transaction whose acknowledgment was lost.

The manager now admits one transition, retains its intended level and clock
anchor through a lifecycle-bound retry, and publishes only after every write
acknowledges. A retry does not overwrite the durable clock with the previous
level's one-second retry deadline. Breaks retain the pending transition and
exclude paused time. A failed post-publication notification still leaves the
next clock armed and requests entry-window reconciliation. Old managers cannot
retry or publish after losing ownership. Restart recovery still repairs legacy
partial table projections before admitting dealers.

This addresses engine acknowledgment and retry ownership. The current table
updates remain separate database transactions; a single atomic publication of
the level and every table is still a separate upgrade and is not claimed here.

Validation: all 1,865 tournament checks across 152 files and the server typecheck
pass, including seven new runtime cases. Deployment and live-hour acceptance
remain separate from local verification.
