# Retain a replacement engine when shutdown teardown fails

Shutdown can begin while an incumbent tournament engine is stopping. Its replacement then enters the registry only to be stopped immediately. That branch previously swallowed every stop error and removed the replacement, including errors before physical ownership was released.

Keep the replacement registered and propagate any stop failure that still owns resources. A cleanup error after verified physical release remains reportable and permits the existing exact-instance unregister. A later successor is preserved.

Regression coverage executes the real GameServer replacement method across the shutdown race, retained and released ownership, a pending stop and a concurrent successor. This does not release or retry any live settlement.
