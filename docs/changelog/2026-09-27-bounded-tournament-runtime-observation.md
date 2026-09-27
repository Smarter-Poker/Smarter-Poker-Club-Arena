# Observe the original stalled tournament owner without changing it

Two live MTT tables retain unfinished original break operations, but database
rows cannot establish the current in-memory manager, park owner or scheduler.
The serving engine already exposes a bounded authenticated diagnostic endpoint.
No maintained audit consumer could call it, despite the existing repository
`INTERNAL_API_KEY` secret being configured.

The existing production-integrity observer now accepts an explicit
`audit-production-integrity` repository dispatch with
`client_payload.tournament_diagnostic`, an array of one or two objects shaped
`{ "tournamentId": "UUID", "tableIds": ["UUID"] }`, each with one to eight tables.
Its new job never runs on the hourly schedule. It reads only the fixed engine
origin using GET, refuses redirects, bounds time and response bytes, validates
the diagnostic identity, and requires unchanged engine identity before/after.
Unknown/truncated runtime coverage stays unknown. The evidence artifact is
retained for three days; no credential or raw transport error is recorded.

No new scheduler, SSH access, deployment, restart, table action, database call
or recovery mutation is introduced. This is observation needed to diagnose
the existing stalls, not their resolution or a gameplay certificate. Invalid
scope, duplicate IDs, authorization/transport failure, oversized bodies,
credential echoes and process replacement have maintained unit regressions
in the existing client test suite.
