# Independent engine and accounting checks

Engine test shards previously waited for the complete isolated PostgreSQL suite, even though they consume no database job output. They now start from the same change classifier. The existing required Server Engine check waits for both and fails on unsuccessful, cancelled, missing or unexplained skipped results. Required tests, matrix size, PostgreSQL fixtures and branch protection remain in place.

The existing direct workflow regression executes the actual aggregate shell with all 36 combinations of engine and accounting results, plus six skipped-work classification cases. Other accounting wiring tests now assert the final required join. The qualification manifest pins the final combined workflow and connected test bytes.

The preceding candidate passed every required CI job. The new dependency graph needs its own hosted result; this source change alone does not prove an end-to-end time saving or a production deployment.
