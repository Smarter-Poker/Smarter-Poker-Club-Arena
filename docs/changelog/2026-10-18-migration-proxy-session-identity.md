# Migration identity survives the database proxy

Member reporting initialization through Apply Merged Migration was cancelled at 2026-10-18 16:10:00 UTC after five minutes. Its startup application name was exposed as Supavisor, so the existing outside-snapshot safeguard did not recognize the already approved installer exemption. The cancellation log identifies PID4163111; durable readback confirms no initialization or reader cutover committed.

The installer now binds its existing application name with SET LOCAL inside the same transaction that applies the file and records its exact original bytes. Both normal admission and settlement-lane sends use this bound transaction. No source migration, financial record, role, cancellation threshold, exemption list, or scheduled safeguard changes.

Native PostgreSQL reproduces a proxy-shaped startup session: the ordinary outside snapshot is cancelled, while the transaction-bound installer retains its snapshot. Existing role, idle-session, privilege, log and schedule proofs also pass. This native fixture is directly enforced in the existing Data Console PostgreSQL qualification. Its scratch parent honors TMPDIR and uses a short Unix socket path for owned SSD workspaces.
