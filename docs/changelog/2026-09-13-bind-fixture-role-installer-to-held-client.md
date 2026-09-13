# Bind the fixture role installer to its held database client

The disposable fixture now passes its real, supervisor-owned application connection to the reviewed role renderer, executes the pinned installer through a separate bootstrap connection, and checks the complete catalog through fresh read-only observers. The installer must acknowledge COMMIT; the graph and membership assertions run in separate transactions and connections.

SQL errors, disconnects and deadlines trigger bounded rollback and connection closure. A new observer must see the installer backend absent before classifying the catalog as original, committed, neither or unobserved. A lost commit response remains a failed run even when the committed catalog is later found. There is no automatic retry, raw SQL or credential-bearing error output.

The ordinary fixture start keeps the original application client idle throughout the installer and observers, then reconnects to activate its new settings before restoring application schema. The existing native lane also executes this driver and requires its complete, source-bound receipt. All original service, preimage and cleanup checks remain.

Local lifecycle tests use controlled database doubles. Actual native rollback and connection-fault cases, fresh password logins, effective role permissions, all future-object default ACL cases, services after alignment, full application schema and funded accounting remain separate requirements. This change does not certify production readiness.

The installer, renderer and assertion SQL retain their accepted source bytes. The two expected-catalog JSON files use repository formatting; their parsed values are unchanged and the driver pins the formatted bytes. Test-only links to existing fixture modules are excluded from the source patch.
