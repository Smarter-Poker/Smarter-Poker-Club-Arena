# Stats alerts follow the publication path

The engine and Prometheus described every missing-stat count as a failed
inline trigger. Accepted atomic hands have deliberately skipped that trigger
since September 8: their stats are published through hand_projection_outbox.
At September 14 01:43 UTC, all 469 missing-stat hands in the sampled window
had both an atomic receipt and pending projection work. The message sent
investigations toward a writer that intentionally did no work for those hands.

The alerts now describe delayed publication and direct investigation to each
hand's receipt, outbox row and active worker, while retaining the inline
trigger warning path for other hand writes. Projection alerts also distinguish
a still-pending drain, actual failures and deferred dependencies. A frozen
poll counter can be the result of the existing drain owning the lane.

Alert identities, expressions, durations, labels, severity and routing remain
stable. This corrects diagnostic attribution; it does not repair the pending
projection work or authorize clearing a drain. Maintenance recovery must still
be followed by evidence that the responsible writer is healthy.
