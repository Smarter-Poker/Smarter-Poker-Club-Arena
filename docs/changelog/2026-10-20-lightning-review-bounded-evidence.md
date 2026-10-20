# Read one finding for an explicit Lightning review

The first reviewed-only operation 94185e61-9955-4a7a-978f-7477011a2deb
(run 39442879798, protected 08e7e3b9) stopped before any review write:
`Signal Evidence: 57014`. It asked the full operator dashboard for evidence.
That RPC assembles current pool reconciliation, reservations, blind debt,
matcher and telemetry history as well as findings, and hit the service's
eight-second statement timeout. No review action was recorded; local cleanup
passed. The earlier successful review operations used a less populated pilot.

An explicit finding review now reads exactly one persisted signal, by primary key
AND the validated private target's cluster ID, using the already configured
service read client. It selects only the same fields used by the existing
review checks and receipt. The authenticated service owner remains the only
writer, through unchanged fn_lightning_operator_signal_review, which repeats its
normal authorization. No table ACL, timeout, detector threshold or runtime changes.

The original signal's complete measured evidence stays checked against its
maintained investigation. Missing rows, duplicate-row errors, another cluster,
changed pair or measured evidence, another operator's prior review and unknown
outcomes refuse the write. No dashboard collection or broad telemetry is needed.
Retained readTo metadata remains historical provenance, not an RPC prerequisite.

Regression tests assert the exact ID/cluster filters for every investigated
finding, no dashboard RPC, and no review for missing/duplicate/foreign rows,
as well as all retained exact-evidence and actor checks. Resume only the same
recorded operation after a fresh durable read; never replay a review with unknown
outcome. Public launch and incomplete browser/financial/recovery gates stay open.
