# Preserve Lobby Restoration Action Evidence

Production run 38994358828 saved the selected PLO preference and read it back in a fresh document. Cleanup then timed out waiting for its MTT save request. The phase journal recorded the intended click but no completed click or POST. The concurrent request timeout masked the click outcome, and retry-only tracing retained no trace because this certificate runs without retries. The underlying actionability cause remains unknown.

The existing bounded request and click now settle together, preserving both failures and the original click call log. The post-click attribute read uses the remaining shared 30-second action deadline instead of an unbounded locator wait. This lobby certificate retains a trace on failure. No runtime behavior, assertion, retry count or 30-second action/120-second journey budget changes.

A focused regression reproduces the lost concurrent click failure before the correction. Production acceptance remains open until the deployed certificate completes successfully or supplies actionable evidence for the remaining cause.
