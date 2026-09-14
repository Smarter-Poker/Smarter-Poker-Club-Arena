# Retain the actual manager lease-release observation

A tournament manager can finish stopping before its database lease-release request returns. The existing retirement path did not retain that request's normalized result on the original manager, which left investigations unable to distinguish a completed stop from a confirmed release.

GameServer now captures an observer bound to the exact manager object, tournament and lease generation before waiting. After the existing single-claim release returns, it records status, attempt count and a validated zero-or-one deletion count before removing pending state. A replacement manager cannot receive a delayed predecessor result. Unknown or malformed outcomes remain unknown. Raw errors, database details and unrelated result fields are excluded from the bounded structured log and the 32-entry diagnostic history.

This is an independent current-main change. It adds no F06 admission, accounting migration, credentials, release retry or cleanup authority. The existing Docker log persists the emitted record; source checks do not qualify host retention, process correlation or a particular production release.

Validation: 91 tests across eight normal server suites passed with zero skips, including seven actual retirement/observer cases, the bounded-history check and existing release/ownership guards. Full server TypeScript compilation passed. The larger G8 composition and its session diagnostics remain separately retained.
