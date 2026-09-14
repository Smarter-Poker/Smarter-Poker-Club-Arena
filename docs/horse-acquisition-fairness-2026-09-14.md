# Pending observations receive a worker turn

Acquisition previously ran only after an idle journal claim. A continuous stream
of completed, deferred or quarantined journal work could therefore keep durable
source requests waiting indefinitely, even when acquisition capacity was
available. Three regression cases reproduce that behavior on the prior source:
twenty ordinary cycles never reached the pending acquisition callback.

The isolated serial worker now gives acquisition a turn after at most eight
ordinary journal turns. An idle journal still yields immediately. Acquisition
has its own cycle, so source reads do not share the maintenance and queue-health
budget. Work remains serial, with the same RPC deadlines, child memory limit,
watchdog and independent journal/acquisition failure backoff. An empty
acquisition during a backlog uses the normal one-second wait; the five-second
idle wait remains when both queues are idle.

This is a turn bound, not a wall-clock guarantee. Network deadlines and failure
backoff still apply. Source requests and journal batches keep their existing
capacity, lease, retention and receipt rules. A full journal can refuse source
admission; fairness does not bypass that check or treat deferred acquisition as
completed. Worker restarts begin another bounded sequence without changing
durable request identity.

No automatic source discovery, completeness authority or adaptive policy
activation is added. This scheduling correction is required before a continuous
observation intake can rely on the existing acquisition worker.

Verification passed server compilation, 31 focused tests across three files and
11,948 server tests across 803 files in 65.68 seconds. The existing 145 skipped
tests and one skipped file remain declared. The native PostgreSQL 17 proof
passed 64 groups. Its fourth actual worker starts with 16 extra journal batches,
captures its first witnessed slice while ten jobs remain, terminates between
slices, recovers the original request and completes all 19 batches. Extra
batches replay identical immutable facts to create queue pressure; they are not
additional source hands or learning samples. All four worker runs stopped their
children, and the temporary database stopped and was removed.

The three original starvation failures are retained. Source publication, served
worker identity, natural workload proof and overall Phase 14 acceptance remain
separate gates; no production workload was manufactured for this check.
