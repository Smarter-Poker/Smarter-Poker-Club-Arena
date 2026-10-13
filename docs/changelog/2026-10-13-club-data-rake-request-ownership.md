# Club Data Rake Request Ownership

Club Data was passing its ledger verification timestamp into the independent rake report. Every successful ledger read therefore retriggered a report, bypassing its failed-read event guard. The panel also remained active while Simple mode hid it.

The page now gives the report a dedicated manual Refresh key. Simple mode pauses report reads, exports and its existing refresh cadence, aborts owned requests, and rejects late responses. Returning to Advanced preserves the selected reporting period, search and drill state. Existing named ledger events continue to refresh the ledger; the report retains its own named event subscription and deliberate controls.

Three mounted regression cases failed against the original source. The candidate passed 32 tests across five affected component files, including paging, search, union scope and export. TypeScript passed. Publication and production verification remain pending. The database report performance correction is tracked in the same task and must be qualified separately.

Real-time law: triggered by existing named ledger events, no snapshot diff.
