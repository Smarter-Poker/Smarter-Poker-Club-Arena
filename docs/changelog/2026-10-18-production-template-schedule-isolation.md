# Production template fixtures cannot start scheduled tournaments

Production verification run `39154643964` passed the Cashier checks and all
493 page checks, then refused cleanup with
`WELCOME_CERTIFICATION_SCHEDULE_FIXTURE_HAS_ACTIVITY`. The standalone template
fixture's active welcome schedule had cancelled an empty daily tournament during
the run. That cancellation correctly retained a closed, zero-value escrow record.
All other activity checks were empty. The cleanup guard and financial history are
preserved.

The fixture now uses the same authenticated creation function and the normal
owner schedule-deactivation function in one database transaction. Its welcome
schedule becomes visible only after it is inactive, so a worker cannot spawn a
tournament between creation and isolation. The rollback qualification exercises
that same transaction before creation is committed. Persisted schedule ownership
and inactive state are checked again, including receipt-based recovery after an
unknown response. Request identity is retained before any possible side effect.

This changes disposable fixture preparation only. Existing externally configured
template memberships and ordinary player club creation retain their behavior.
No engine, schema, escrow, retirement guard or player funds are changed.

Validation and the exact production run are recorded in the task checkpoint.
