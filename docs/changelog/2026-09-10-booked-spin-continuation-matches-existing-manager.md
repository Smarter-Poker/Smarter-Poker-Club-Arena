# Booked Spin continuation follows the existing manager

The database resolver previously ignored a funded Spin's frozen continuation rule after its stored ladder ended. Capacity-created tables could therefore use different blinds from the existing manager when a historical booked rule differed from the local default. This migration reads that frozen rule and follows the manager's JavaScript Number arithmetic, including positive half rounding. The concrete `100 * 1.15 / 10` witness resolves to a big blind of 110 in both implementations.

This is a database-only correction. Removing its added local declarations and booked-Spin branch reproduces the entire captured installed resolver byte for byte. Persisted rows, existing HU behavior, legacy Spin without a receipt, and the generic MTT tail are preserved. The private resolver remains postgres-only; its public wrapper and all current table/anchor writers are unchanged.

The exact installed body is `b5769b647e5b106caaf51982ac245ee8`; the proposed body is `4f83c09a69eecc766a1f3984feeb9823`. The migration refuses missing/drifted authority or changed execution privileges before replacing anything and verifies its final body, search path and ACL. It rewrites no tournament, seat or wallet rows.

## Verification

The disposable PostgreSQL 17 probe compiled the actual manager and receipt helpers from pinned current-main commit `d9dbf1388617ebfad71b00040aac22819c4103af`. It passed 93 manager/SQL cases (80 approved Spin rows and 12 numerical boundaries), 60 unchanged generic MTT cases, 24 unchanged legacy HU/Spin cases, 13 malformed formula refusals, one zero-round refusal, three raw-JSON-number cases and three preflight refusals. The installed resolver disagreed with 13 of the positive expectations; the proposal and manager disagreed with none. The probe stopped and deleted its local cluster.

Run `python3 scripts/dev/probe-booked-spin-authority-pg17.py` with Node, TypeScript and PostgreSQL 17 available. Optional `POKER_AUDIT_PG_BIN`, `POKER_AUDIT_NODE` and `POKER_AUDIT_MANAGER_REF` locate dependencies or deliberately select another reviewed source. Full output is written to `/tmp/codex-booked-spin-authority-results.json`; committed evidence records source hashes, frozen formulas and results.

## Rolling adoption and limits

The existing manager already calls `continueBookedSpinBlinds` before generic overflow, so applying this SQL does not require a new HU writer to become active. Current stored consumers are the private resolver through `fn_tournament_current_blinds`, then `fn_ensure_late_registration_capacity`; capacity is reached by registration, seat choice and the server manager. All receive the same booked Spin values after this correction. The proof covers pinned shipped source and the captured database body; it does not claim an inventory of every live process.

The separate combined short-format migration `20260910070354` and HU manager changes remain deferred and must not be deployed with this narrow commit. HU level-13 correction still requires a verified clock activation or coordinated owner boundary to prevent mixed writers. Atomic clock and maintenance/pause composition remain open. This evidence neither activates them nor closes the broader audit.
