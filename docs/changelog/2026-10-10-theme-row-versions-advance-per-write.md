# Theme row versions advance for every database write

The first partial appearance save inserts schema defaults and updates the requested fields in one transaction. The installed timestamp trigger used transaction-stable `NOW()`, so both realtime events had the same version. The account cache correctly refused the second event as an equal-version conflict, leaving both devices on the default felt despite durable carbon-red persistence.

Reserved forward migration `20261010075740` changes only the existing timestamp function to `GREATEST(clock_timestamp(), OLD.updated_at + INTERVAL '1 microsecond')`. It preserves postgres ownership, invoker security, public search path, service-only execute ACL and the existing trigger. Exact preimage/postimage and metadata guards refuse drift; the commented guarded rollback restores the original body through a new migration. Existing ownership, authorization, receipt and consumer conflict rules remain intact.

Native PostgreSQL 17 proves the failure before the patch and strict first-save versions afterward, serialized device writes, exact replay without another event, request-ID collision refusal, a future-clock microsecond floor, metadata preservation, rollback and guarded reapplication. The captured native two-event sequence feeds the actual hook regression (24 tests pass). The existing directly triggered Phase 1 native qualification invokes this proof; no new release workflow is introduced.

The recovery branch started at `71aa27a37d`, which already contains the disjoint Cashier and Diamond Spins changes from PRs 6624/6626. This repair preserves those incoming changes. Production installation and publication are owned by the coordinating agent and are not claimed by these local proofs.
