# Scoped launch installation settlement lane

The protected scoped launch migration was refused by a four-second lock wait,
then aborted for a live cross-table deadlock. Read-only inspection confirmed
zero installation records, no new reset tables, and the original guard baseline.
No balance reset or floor command occurred.

The maintained installer now accepts an explicit settlement-lane option only
for this exact migration without concurrent indexes, recovery or batch modes.
It acquires the original global settlement lane on the same dedicated connection
before sending DDL, with a three-second admission limit. Session ownership spans
the migration's BEGIN/COMMIT. Refusal rolls back and releases ownership; transport
loss remains unknown and requires durable readback. Exact SQL and atomic history
bytes remain unchanged, and the default installer route is unchanged.

The existing native TLS qualification verifies actual two-connection money
blocking, bounded refusal before DDL, rollback/release and exact history. All
existing TLS, window, replay and lost-connection cases pass. Four focused
installer/wiring test files passed 730 cases. Production installation and the
reset's live rehearsal, cutover and resumed play remain unverified.
