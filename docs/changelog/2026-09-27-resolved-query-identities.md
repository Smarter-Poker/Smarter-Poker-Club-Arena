# Resolved identities before UUID reads

Observed PostgREST failures sent unresolved `demo` club/union aliases and the pre-authentication `guest` identity into UUID columns. The union read, announcement consumer and tournament paid-entry read now require resolved UUIDs. Valid authenticated reads retain their error handling and paid-entry state; this does not change game transport, seating or financial writes.

Announcement loads also retain request identity across route changes and clear the previous club's local presentation state, so a delayed resolution cannot replace the new club's result. Regression tests execute the actual service, mount the announcement component, and execute the maintained paid-entry control flow. The initial UUID regressions failed before the fix. Publication and production request evidence remain separate from local verification.
