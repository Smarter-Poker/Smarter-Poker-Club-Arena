# Maintenance V3 Integration

The engine used the three-argument compatibility thaw without an ownership-bound release receipt. The approved integration uses the deployed five-argument contract and waits for the database release witness before resuming tables. An invalid receipt, lost ownership or incomplete checkpoint cannot authorize resume. Retry and release waits are cancelled when their process lifecycle ends. Durable expired rows are recovered under a new ownership token, and reconnect duration is no longer capped at 900 seconds.

The exact review patch 7fad49954a5968fdc53b36d2bfa230fe74d236897b4d251900e3f20212666953 was applied after the user's explicit approval. The integration additionally retains one immutable request across bounded retry attempts. Existing independent-pause, deadline, persistence, shutdown and restart tests remain active. Historical expectations that cleared unproved freezes were updated to the current deployed database contract.

Validation: server TypeScript passes; 178 maintenance/clock tests pass, including 13 direct integration cases through the real maintenance controller and v3 helper; the full server suite passes 9,302 tests with zero failures and stable source inputs. The existing native v3 proof covers 300-second and 1,200-second freezes with exact rollback. All-fourteen-family nonempty coverage and separate committed-installment admission remain explicitly open and are not inferred from these totals.

Production creation-options migration 20260911112409 applied successfully. The exact candidate SHA256 is e16b3a057460833cd74c7a2da612df8b2c5269e156a7cc7b8116679d7fb6b24a. Readback at 11:24:32 UTC verifies creator postimage ef2671b3cb67a8c710a7fbe3f0431ef6 and unchanged public wrapper and eligibility predicate. The migration file recovers that applied candidate under its actual receipt version.

The user-approved browser terms were accepted. Read-only tournament details, blinds, ranking, entries, tables and rewards panels rendered successfully. No tournament registration, purchase or player action was submitted. This observation does not substitute for complete interactive financial acceptance.

Stage B and exact-consent production activation remain pending a genuinely available lock boundary. No guard, lock timeout or protected release window was bypassed. This report does not claim Phase 3 complete or the integrated engine deployed.
