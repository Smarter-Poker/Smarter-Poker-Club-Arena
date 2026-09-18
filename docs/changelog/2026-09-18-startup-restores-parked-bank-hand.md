# Startup restores the parked bank's hand identity

A fresh engine left `handCount` at zero because its history lookup only logged
the latest completed hand. The parked-bank reader correctly rejected the
different hand number, then startup overwrote that checkpoint before loading
the seat roster. This was observed after the September 18 03:16 UTC cutover:
previously initialized checkpoints became new-instance, zero-hand empty banks.

Startup now restores the validated completed hand number before reading parked
banks. An unreadable or invalid history result rejects startup through its
existing failure owner before any replacement checkpoint. New hands retain the
global allocator, and crash recovery still restores its own in-flight number.

The existing parked-bank suite drives real `start()` from its default zero
through history lookup, bank read and the first maintenance checkpoint before
the roster sweep. It verifies exact remaining seconds, uses, occupancy and
already-billed basis, with no accounting write. Refused, thrown and invalid
history reads preserve the prior row; a genuinely empty history still starts.
Four regression cases failed on the old implementation. Local and hosted
results and production adoption evidence are recorded separately in the owning
Must Move completion checkpoint. This repair does not reconstruct banks lost
by earlier restarts.
