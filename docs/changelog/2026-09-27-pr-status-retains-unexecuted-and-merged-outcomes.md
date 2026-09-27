# PR status keeps unexecuted checks and completed merges distinct

PR5411 had already merged when the read-only status helper reported that its intentionally skipped build checks had failed and that it would not merge. The helper now reports known skipped or neutral required verdicts as NOT_RUN with nonzero exit 5. Only completed successes from each required reporter can produce GREEN. Actual failures, missing checks, unreadable responses, and changed commit identities remain non-green.

The final same-head PR read now supplies the observed merge state in both single and all-PR output. An already merged PR is labeled MERGED even if older mergeability fields still say dirty. Merge completion does not certify an unexecuted check, and this correction changes no workflow classification, required gate, or provider setting.

The actual CLI regressions cover skipped and neutral outcomes, newer attempts, mixed failure and missing evidence, an open-to-merged transition during the read, text and JSON output, and all-PR exit aggregation. Existing denied-read, exact-head, pagination, and trusted-reporter tests remain enforced. Five new assertions failed on the predecessor before the correction.
