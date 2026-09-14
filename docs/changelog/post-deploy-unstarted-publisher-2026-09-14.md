# Distinguish an unstarted publisher from a failed publish

GitHub cancelled publisher run 34831934935, attempt 1, while it was pending. Its exact attempt has zero jobs, so it published nothing. Post-deploy run 34832023124 nevertheless failed while looking for a publish-to-origin job.

The publication gate now reads jobs for the triggering attempt and requires a complete response. Only a completed, cancelled attempt with zero jobs stands down without browser execution. Any started job still requires the existing origin and release-step proof. A verified origin still runs browser checks even if a later optional job failed or was cancelled.

Fifteen dependency-free tests execute the workflow's actual verdict program, including the original zero-job failure, malformed and incomplete responses, failed origins, safe forward stand-downs, and verified publication under different overall conclusions. The existing concurrency, provenance, cleanup, and zero-retry checks remain in place.
