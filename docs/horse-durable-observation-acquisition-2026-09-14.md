# Durable observation acquisition

A source read previously had to finish before its request reached the durable
journal queue. Process loss in that interval could erase the actor and time
window being acquired. `admitObservationCapture` now records that immutable
request first. The isolated journal worker resumes admitted requests from the
database; it does not need an in-memory source payload after restart.

Each request covers one actor and at most six hours within the latest day.
Its deterministic key binds the actor and both interval endpoints. The private
queue admits at most 256 unfinished requests, including unresolved gaps, under
a nonwaiting capacity reservation. Existing requests remain replayable during
capacity contention. A claim takes a 30-second token lease using row locks
and `SKIP LOCKED`. Expired claims can resume; stale tokens cannot acknowledge.

The worker uses the existing single-snapshot committed-history reader and
public-observation qualifier. One transaction binds the exact canonical public
payload to the existing durable journal queue and acknowledges its acquisition
request. The acknowledgment checks actor/window, batch key, digest and count.
A lost response remains unknown to the caller; a committed request or payload
can be recovered without duplication. Queue pressure retains the original
request with bounded backoff. Source overflow, invalid qualified data and
expired source windows remain explicit gaps. Transport failures and missing
atomic source receipts remain retryable uncertainty, never partial success.

Acquisition runs only after an idle journal cycle, in a separate cycle with
at most three five-second RPC deadlines. It shares neither a cycle nor its
watchdog budget with retention or health reads. Journal and capture retention
alternate, including after a failed pass. Each capture retention pass removes
at most 100 admitted receipts older than 32 days; unresolved requests and gaps
are retained. The existing worker heap, watchdog, restart and shutdown
ownership limits remain in force.

One bounded database health snapshot reports both independent queues.
Acquisition counts distinguish queued, leased, expired, ready and gap states;
257-row lookahead refuses an oversized population instead of truncating it.
Only validated counts cross the worker boundary. Samples expire when stale
or after worker ownership changes. Acquisition admissions have their own
counter and do not increment journal completions. Neither empty queue proves
observation coverage.

The migration adds one RLS-protected metadata table and five service-only
functions with fixed search paths. Applications and the service role have no
direct table mutation rights. It adds no financial trigger, hot-table foreign
key, model activation or production observation backfill.

Verification: TypeScript compilation and 11,755 server tests across 796 files
passed (145 existing skipped tests and one skipped file; 71.60 seconds).
The final native PostgreSQL fixture passed 39 groups and verified database
and worker cleanup. Its acquisition cases cover lost admission/claim/finish
responses, immutable scope, concurrent leases, stale tokens, both queue caps,
capacity contention, backpressure, source expiry, retained gaps, bounded
retention and role isolation. The actual compiled worker and unchanged
Supabase HTTP client recover a previously leased request, acquire 12 actual
controller observations, complete the journal write, recover from real thread
termination and stop with no later RPCs. The fixture uses three synthetic
controller hands locally; no production hands or learning writes were made.

The initial native run exposed a fixture ordering error: an earlier recovery
case deliberately removed source history. The fixture now saves its three
local source rows before that deletion, proves recovery without those rows,
and restores them before acquisition tests. An unsupported assertion helper
was also replaced with assertions available in the installed test version.
Failed runs remain in the task evidence. Native HTTP is not production
PostgREST authorization or load qualification.

This component processes already admitted requests. Automatic source discovery
and admission, source cutover/completeness authority, gap recovery, measured
traffic capacity, actual model consumption, counterfactual utility, holdout
reuse controls, shadow evaluation and activation/rollback remain open. The
original source timestamp and global hand number are not commit watermarks.
No complete-window flag is invented, and this component does not complete
Phase 14 or certify the fleet.
