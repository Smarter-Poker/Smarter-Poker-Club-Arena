# A Fee Queue Insert Never Leaves Its Calling Promise

The original fee queue insertion could move to a process-local timer after temporary database failures. That split ownership: the caller returned while the only remaining copy of the write lived in memory, and a process exit could silently discard it.

The timer driver and its `pendingWrites.ts` module are removed. `queueUnbankedFee` now performs its bounded identical insert attempts inside the original awaited call. If those attempts do not produce an acknowledgement, the same promise checks whether the fee is already queued or banked and then raises the existing critical alert only when the money is definitely unaccounted for.

The regression suite covers an exhausted insert for a missing fee, an ambiguous response for an already banked fee, and a later inline acknowledgement. No case delegates the payload to a watcher, interval, successor process, or alternate money writer.

No live wallet or financial record is changed by these tests. The database-backed `pending_fee_distributions` obligation remains the durable authority once its insert is acknowledged; this change removes only the process-local retry band-aid.
