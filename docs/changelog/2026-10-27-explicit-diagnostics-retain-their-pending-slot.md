# Explicit diagnostic requests retain their pending slot

The production integrity audit used one workflow concurrency group for both
scheduled audits and explicitly requested bounded observations. GitHub permits
only one pending run in that group and replaces it with a newer request even
when `cancel-in-progress` is false. Diagnostic run 40558408545 was cancelled
without any job on October 27 while waiting behind an earlier audit.

The workflow now gives each dispatch selecting one of its six existing bounded
observation jobs a group derived from its own run ID. Scheduled audits and
ordinary dispatches retain the original shared group. Cancellation remains
false; job selectors, input validation, credentials, read-only limits, schedules
and release/runtime guards are unchanged. No request is retried automatically.

The existing scoped tournament diagnostic source regression executes the actual
group expression against scheduled, ordinary, unknown-selector, null-selector,
wrong-event and each supported explicit request fixture. It reproduces the
failure before the change and proves that later scheduled/explicit requests use
different pending slots afterward. The existing HTTP, authorization, byte-limit
and immutable engine observation tests remain enforced alongside it.

Reference: [GitHub concurrency behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
This delivery changes the diagnostic route only; the requesting task owns its
next bounded observation and the separate frozen-table repair.
