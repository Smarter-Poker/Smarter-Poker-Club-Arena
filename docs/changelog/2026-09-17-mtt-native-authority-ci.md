# Retain MTT blind and played-launch authority checks in CI

The existing PostgreSQL 17 accounting job now invokes the retained atomic-blind-publication and played-MTT-launch probes. Their source, fixture and migration inputs already select this required server dependency, but previously neither probe had a workflow caller. Two routing regressions fail against the unchanged workflow and pass after binding the existing scripts to the installed PostgreSQL 17 tools.

This adds no workflow, release stage or scheduled process. Each probe runs once without error suppression; existing accounting failure propagation remains unchanged. Previous native local execution is retained as the same-component baseline. The changed hosted invocation must pass before protected merge.

The probes use real captured authorities with declared synthetic rows and maintenance/authentication stand-ins. They establish atomic publication, lease and recovery behavior within those fixtures, not complete production gameplay, money settlement or platform thaw. No production database or business behavior changes in this patch.
