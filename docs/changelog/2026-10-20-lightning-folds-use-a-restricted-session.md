# Lightning folds use a restricted database session

The remaining pilot latency included HTTP transport delays outside the fold
transaction. In the retained 2026-10-20 14:30–14:53 UTC provider observations,
request `01a159c6-6b81-71f8-a6c0-a91369010c1f` took 3,472 ms at the origin while
its upstream duration was 17 ms. Another request took 1,708 ms with 5 ms upstream.
Those observations establish a separate contributor from instance-row lock
contention; they do not attribute every historical spike to one cause.

This change gives the original `fn_lightning_fast_fold` transaction a dedicated,
bounded PostgreSQL connection pool. A separate login can execute one fixed
wrapper. The wrapper retains the existing actor context and pre-request lease
fence, then calls the original typed fold function. Its result reaches the host
only after synchronous commit. An unknown dispatched outcome cannot fall back
to HTTP or be replayed by the host retry helper. Admission failure before the
wrapper is dispatched retains the existing HTTP route.

The credential follows the existing lease-session provisioning pattern: the
migration generates its password inside the database, writes its session URL to
Vault, and grants the existing service client access through one credential
reader. The runtime keeps that result in memory. Agents, workflow inputs,
artifacts and host environment files do not handle the secret value. TLS remains
verified. The heartbeat credential, session and privileges are unchanged.

The login has no service-role membership or direct table-write grant. The
database's existing PUBLIC read helpers remain available under their existing
permissions. A metadata-only inspection found no PUBLIC table-write grants and
no PUBLIC money-writing SECURITY DEFINER entry point; the new migration does
not alter unrelated permissions.

The migration must be installed before engine adoption. Source qualification,
protected merge, migration installation, engine publication and live latency
acceptance remain separate evidence. Pilot rules, population thresholds, rest,
caps, bookings, wallets and latency thresholds are unchanged.
