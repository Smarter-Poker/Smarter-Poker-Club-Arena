# Bound the evidence interval for Lightning finding 158

The first reviewed-only operation 94185e61-9955-4a7a-978f-7477011a2deb
(run 39442879798, protected 08e7e3b9) stopped before any review write:
`Signal Evidence: 57014`. The existing operator dashboard collected current pool
reconciliation and several days of historical telemetry while reading one signal,
and exceeded the service's eight-second statement timeout.

The existing authenticated dashboard RPC remains the supported reader. Finding
158 now pins both read endpoints: 2026-10-20T11:06:59Z through 11:07:01Z.
Its persisted detected_at is 11:07:00.414595Z, and window_end is 11:07:00Z,
so the installed window_end/detected_at predicate includes the exact signal.
The complete original 24-hour timing evidence stays on that row and is still
checked unchanged. Historical telemetry collection is reduced to two seconds.
Existing other findings retain their original read intervals. Current pool
reconciliation remains inside the maintained RPC; live continuation must verify
that the bounded read completes, rather than infer success from query size.

Access prechecks rejected an intermediate direct-table-read candidate: both
service_role and authenticated intentionally lack SELECT on this internal table.
That candidate was replaced before merge. No table access is granted, no new RPC
is added, no timeout or detector threshold is raised and no operator authorization
is bypassed. The unchanged authenticated operator door owns the reviewed write.

Regression tests assert both endpoints for every investigated finding and verify
that finding 158's two-second interval contains its exact persisted detection.
The first operation recorded no actions and local cleanup passed. Read durable
status again before continuing the same operation. Public launch and incomplete
browser/financial/recovery gates remain open.
