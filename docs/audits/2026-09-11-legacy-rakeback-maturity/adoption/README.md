# Standalone adoption receipts

The explicitly approved standalone legacy repair was applied by the root coordinator on 2026-09-11 through Supabase apply_migration. The submitted source was the exact reviewed atomic entrypoint SHA256 a55e792f12040799a20fcf6d54969059efecaea3869c3aa148191fe1b083c4c7. At 07:50:03.546161 UTC, all six function and two trigger runtime checks passed, including body identity, owner, security mode, normalized ACLs, search paths, arguments, defaults and result types.

The tool generated migration version 20260911074903 with one stored statement whose source hash exactly matched a55. Root then performed one guarded metadata-only version update to the normally reserved repository version 20260911072837. The final 07:53:52.586074 UTC read returned exactly one matching row at that reserved version, with the source and statement-array hashes unchanged. The same six-function/two-trigger gates were checked inside that guarded transaction. The payment SQL was not reapplied.

## Preserved evidence

- approved-admission-receipt.json records this agent's fresh 07:44/07:45 UTC read-only checks: the original three owners and nine helpers passed, required state matched, and the bounded scan covered all 1,767 closed pending rows under its 5,001-row cap, with all four malformed counts zero. Its one potentially conflicting relation lock is retained as a timestamped observation. The earlier disconnected receipt-only write was reconciled as absent before this file was created.
- approved-application-receipt.json is root's normalized application, runtime and migration-history receipt. It includes the separate final 07:48:33 UTC admission with no conflicting target-relation locks and a NULL break-window refusal, the successful apply response, generated and final migration rows, and bounded advisor observations.
- applied-ledger-alignment.sql.txt preserves the exact already-executed metadata statement for audit comparison. It is historical evidence, not a migration or an instruction to execute it again. The receipt pins its SHA256.
- read-only-receipt.json preserves the earlier automatic rejection and unchanged production readback. Specific user approval was supplied afterward; those earlier observations are historical.

This supplemental directory does not change the immutable 988db864469e0d2543b969fc0032c4d8eb7b9fa3 source subtree outside adoption or the reviewed atomic SQL. The normal repository migration is 20260911072837_legacy_rakeback_closed_period_single_payer.sql. The earlier 20260911070726 reservation mentioned in the historical preparation was superseded before application.

## Read-only query references

1. 01-admission.sql checks original owner/body/normalized ACL identities, absent new guard/helper names and capture state, receipt uniqueness, the current append-only identity, relevant relation-lock counts, and the existing break-window refusal helper. It is a pre-application query; its original-owner and absence conditions are expected to stop passing after this adoption. The helper refuses UTC minutes 50 through 02. No override was used. The atomic source retains its one-second lock and ten-second statement timeouts.
2. 02-malformed-closed-periods.sql scans at most 5,001 closed pending rows and returns counts only. The complete-for-filter flag and four zero counts establish only these specified data prerequisites.
3. 03-post-apply.sql verifies the exact six functions and two enabled, noninternal, row-level BEFORE triggers. The successful runtime readback used these reviewed gates. The triggers include the exact status-column filter, with no WHEN predicate, constraint, deferrability or arguments.
4. 04-migration-receipt.sql reads the historical reservation or the matching semantic name, so it also discovers the actual generated and final versions. Its single-statement source, joined-source and statement-array hashes permit exact correspondence checks.

## Scope

This agent performed read-only production checks and preserved evidence; root performed the approved application and metadata alignment. No live financial RPC was invoked for verification. The installed source identity and migration correspondence are verified; this receipt does not establish full-project advisor cleanliness, whole-dataset accounting correctness, producer/bank finality, or UI publication. The UI release is tracked separately by the root coordinator.

The existing native proof and its limits remain unchanged: 22 standalone groups include first-install overlaps, exact funding/receipt conservation and atomic installation refusal. Old callers may require a retry after a selected deadlock rollback. Full current-production trigger composition and live authenticated money-flow acceptance are not claimed. Any future adoption of the broader captured-source candidate must account for these now-replaced owners and reprove its admission gates; this legacy repair does not activate captured-source capabilities.
