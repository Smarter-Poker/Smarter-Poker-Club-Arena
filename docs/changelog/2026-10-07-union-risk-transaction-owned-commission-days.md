# Union Risk reads exact transaction-owned commission days

The active Risk report spent 4.883 seconds scanning 1,084,468 commission rows across 111 agent/club pairs on a cold read. Combined with its other unchanged branches, this exceeded the existing request budget.

Complete closed UTC days now use private per-agent facts. An explicit bounded PostgreSQL owner call initializes each recent closed day under the same sorted club advisory keys used by the original commission INSERT owner. That original transaction always adds its exact deltas, including backdated and negative amounts. Corrections and deletion invalidate completeness; missing days, partial day edges, current/future rows and older explicit windows use the original raw sums. No timer, scheduled refresh, financial transfer or timeout increase is introduced.

Native PostgreSQL 17 qualification compares original raw financial sums and full report outputs, including 111 pairs/111,000 source rows; covers timezone edges, signed/null amounts, missing markers, rollback and relevant mutations; and verifies both initialization/INSERT interleavings plus repeatable-read serialization. Existing financial INSERT callers retain their isolation levels. Only baseline initialization requires read committed. Private owner/ACL/search paths and actual trigger wiring are asserted. Existing direct native accounting workflow runs the retained cases.

The active UI uses the default recent window. Older explicit report windows remain semantically identical through raw fallback; no older-window cold-capacity guarantee is made. Local fixture performance is synthetic and does not certify the production request budget. Production installation, bounded initialization and affected live proof remain required before completion.
