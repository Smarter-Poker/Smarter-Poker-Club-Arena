# Isolate publication decisions and release test evidence

Publication now resolves its exact protected-main target and runs all four client test shards on fresh hosted runners. Historical PR checks no longer skip the release suite. The installed test-dependency cache has a new publication-only namespace, so earlier entries from persistent PR runners are not restored. Build and tests still run in parallel; ordinary PR CI retains estate routing. Skipped, cancelled or failed release tests block both web and native publication.

CI cancellation is scoped to each PR and immutable head. An out-of-order old event cannot cancel the current required checks before the current-head admission step has a chance to reject it. Admission still rejects superseded work before dependency setup. Its runner assertions now match the merged CI routing while preserving read-only permissions and every admission/aggregate check.

The workflow predicates and group expressions are exercised directly. Eight regression cases fail on the previous workflow source. This is source verification; Actions execution, merge and production publication remain separate acceptance steps. No evidence of runner compromise is claimed.
