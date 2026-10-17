# Installed Records Required By Mobile Delivery

PR #7099's required migration-ledger check failed because two migrations installed on October 15 had no source file after the 24-hour grace period. A third installed record reaches the same 24-hour gate while these checks queue. Recover their exact stored SQL through the configured read-only Supabase interface and bind it in the existing recording manifest. No SQL is applied or replayed.

- `20261015101106`: 8,370 UTF-8 bytes, MD5 `c9684fe775e73192de3c1684ec32ac61`.
- `20261015102509`: 3,268 UTF-8 bytes, MD5 `b60e8d7b22fc2317dcf76096d924bff8`.
- `20261015131200`: 5,324 UTF-8 bytes, MD5 `d22aed0c9e72695c797e7920f0f41fcb`.

All three hashes match `public.fn_ca_migration_text` and the stored migration statements. The first also matches the immutable existing export in commit `49ed57b923d`. The second uses the actual installed body, without the later authored header and transaction wrapper. Other agents' checkouts and the later cash-out-message successor remain separate.

Live readback found no relevant unauthenticated-writer, anonymous-writer or anonymous-reader audit findings. The money-check and invoice-delivery functions deny browser execution; existing authenticated visibility/profile readers retain their grants. These files only repair source bookkeeping needed by the required gate. They introduce no engine replacement, database installation or new scheduled behavior.

The replica-guard functions also deny both browser roles. Only the cluster identity reader retains service-role execution. Installation is confirmed by recorded version and byte identity; exact historical execution times are left unknown rather than inferred from version stamps.
