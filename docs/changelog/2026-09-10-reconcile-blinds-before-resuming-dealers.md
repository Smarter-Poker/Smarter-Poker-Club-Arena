# Reconcile blinds before resuming dealers

If a table's blind update failed during a level change, a replacement manager could restart that table at the old blinds while the rest of the field used the new level.

Recovery now checks existing table rows against the durable tournament level before starting any dealer. It corrects only mismatched rows. If a correction fails, recovery remains stopped before any dealer is created or started.

Two runtime cases reproduce the mixed-level recovery and verify successful correction and withheld startup when the write remains unavailable. Both pass, and server TypeScript checking passes. Existing clock cases were not repeated. This covers manager recovery; live transition fan-out and production adoption remain open audit items.
