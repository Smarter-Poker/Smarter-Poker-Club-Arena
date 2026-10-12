# Isolated Auth Startup Reports Each Service Safely

Actual Auth qualification37890734076 failed at service-health before signup. The prior identical launcher passed this stage, but its combined probe discarded endpoint outcomes and skipped REST whenever Auth threw. The cause remains unknown.

Keep the existing50 attempts, one-second request bound and100ms pause. Observe both endpoints independently; on failure report only closed service/outcome/status fields and state-only reads of the exact owned containers. Never print raw responses, exception messages, environment, logs or credentials. Failed startup still refuses qualification and uses the original owning cleanup.

Focused regressions verify both endpoints are observed when one refuses, immediate healthy completion, exact unchanged bounds, failed statuses and secret redaction. This change supplies diagnostic evidence for the next changed qualification; it does not claim the startup cause is fixed or Auth is qualified.
