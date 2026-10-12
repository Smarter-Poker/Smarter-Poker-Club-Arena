# Leaderboard Isolated Schema Sequence Metadata

The actual isolated Auth run37866528832 failed before restore because its dedicated read replica cancelled the export transaction during recovery. The remembered query category was per-sequence definition metadata. Routine batching had passed native parity, but had not completed the actual production-schema export.

The qualification client now batches metadata for exactly the sequences selected by native PostgreSQL17 dumping. Native sequence serialization, identity and ownership, ACLs and all schema categories remain authoritative. Missing or inconsistent selected rows refuse the export. No sequence values are read by this schema-only change.

The existing directly invoked Accounting4 and qualification build routes compare the changed exporter with the pinned stock exporter, restore the complete fixture and compare the complete catalogue. No primary fallback, primary configuration change, recovery-control override or financial SQL change is introduced. This change is an engineering candidate until actual guarded export, restore, Auth and financial qualification pass; remembered query metadata does not prove the last active query or total export duration.
