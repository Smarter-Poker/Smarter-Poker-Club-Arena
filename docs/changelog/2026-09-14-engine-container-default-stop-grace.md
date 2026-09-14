# Preserve the engine shutdown grace on the container

The canonical startup script gave deployment stops 45 seconds, but did not set the container's default stop timeout. The engine itself allows 40 seconds to release ownership. A Docker stop or restart without an explicit timeout therefore used the ten-second Linux default and could force-kill the process before its shutdown deadline. A read-only production inspection on September 14 confirmed that the container's StopTimeout was null.

Candidate startup and sealed-image recovery now persist a 45-second container stop timeout, retaining their existing restart policies and exact image authority. This protects callers that use the container default; an explicit shorter timeout or forced kill can still override it. It does not identify the actor behind the September 14 forced restart or prove earlier settlement cleanup.

Validation: the actual sealed candidate/recovery startup test and the process-deadline consistency test both fail on the old source. All 91 focused tests across four files passed without skips; the deadline test was rerun after tightening its source match. Shell syntax and formatting checks passed. Installation and live container readback remain required.
