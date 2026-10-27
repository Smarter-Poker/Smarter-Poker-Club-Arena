# Isolate Disposable Git Housekeeping

Club Arena publication failed when the database-maintenance native fixture removed a temporary repository while Git's detached automatic maintenance could still write into `.git`. A real local fetch reproduced that detached child in Git's trace.

The fixture now disables automatic maintenance and legacy automatic garbage collection before its first commit. A regression runs the real local fetch and rejects an automatic housekeeping child. Cleanup remains strict, and the existing release, immutable-image, financial and maintenance assertions remain unchanged.

Validation: the new regression failed before the fixture configuration change; all 31 native cases pass afterward. This changes only test fixtures and does not replace the serving engine or install a migration.
