# Refuse obsolete pull-request heads before heavy CI work

Queued jobs can start after their pull request has moved to a newer commit. The six expensive job types now read the current PR identity immediately after checkout and before dependency setup, cache restoration, compilation, or tests. An obsolete, closed, mismatched, or unreadable head fails admission; it cannot produce a successful or skipped required check. Scheduled full checks remain unchanged.

The read uses only contents and pull-request read permissions, validates both repository names and immutable IDs, and has a 15-second deadline. Client shard fail-fast is disabled so one admission refusal cannot cancel a sibling already doing work. Existing required-check aggregation and job conditions remain intact.

Validation: 49 native Node tests passed with no skips, including changed/returning heads, fork identity, unreadable responses, and required-check failure behavior. Workflow validation passed. This admission check takes a snapshot when a job starts; it does not cancel older work already admitted or rewrite historical workflow runs. Hosted Linux execution and queue impact require CI evidence.
