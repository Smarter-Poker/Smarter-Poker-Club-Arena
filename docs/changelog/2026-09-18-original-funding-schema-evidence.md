# Record installed original-funding schema in the existing CI catalogue

The new-migration gate rejected five functions and three receipt tables from `20260917233447_tournament_original_funding_and_obligation_receipts.sql` because its catalogue omitted already installed objects. Production readback at 2026-09-18T02:20:09.760626Z confirmed every function identity, owner/ACL, all table columns, and migration history version20260917233447. The additive owned manifest fragment records exactly that observed catalogue; no database migration was replayed, no gate exemption was added, and no application behavior changed.

Validation: existing migration gate on the full PR diff fails with eight missing objects before the fragment and passes after it. The directly triggered gate remains the regression check. Root preserved the raw production readback with the release evidence.
