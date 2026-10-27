# Read the original lease incident through the existing diagnostic

The October 27 09:12 UTC lease-loss episode cannot be attributed from later
health counters. Current Docker logs are bounded and may have rotated; the
maintained Prometheus configuration retains fifteen days, but the public
monitoring route currently returns 404. The existing authenticated, manually
dispatched host diagnostic read only log evidence.

That same diagnostic now accepts `leaseIncidentMetrics: true` together with
its existing completed fifteen-minute incident window and exact table scope.
It performs one fixed localhost Prometheus range query against the configured
`engine_game_server` job for twelve named lease,
renewal, event-loop and fleet-stall metrics. Callers cannot select a URL, query,
metric, label, command or wider window. The existing twenty-four-hour admission
limit, host-key pinning and before/after engine identity checks remain.

The response admits at most sixty-four series and sixty-one samples per series,
with bounded response bytes and transport time. Only fixed enum labels leave
the host; scrape job/instance metadata is discarded. Non-finite readings remain
unknown. Partial, missing and unavailable results have distinct outcomes and
never mean healthy. Range-query times are evaluation times, with Prometheus
lookback explicitly disclosed; historical process identity remains unproven.

The existing native fixture failed three new incident-read cases before this
extension. It now covers explicit opt-in, unchanged legacy calls, actual remote
entry framing, identity bracketing, numeric/label/window bounds, the fixed HTTP
request and unavailable/oversized/error responses. The existing scoped-runtime
test runs that fixture in client CI. This is a finite read-only diagnostic;
it does not repair production state, schedule work or initiate a release.

This change does not itself establish the original expiry's cause. A protected
merge and one explicit observation with metric evidence are still required.
