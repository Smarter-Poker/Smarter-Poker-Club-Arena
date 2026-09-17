# No-floor union continuation successor — source only, UNRUN

This proposal belongs to a separately reviewed financial successor. It is integrated only in the separate CA successor worktree, outside the sealed `fcdb5336f2d88dd2db77961963d58f40f50ce304` 24-component bundle, and outside the monitoring implementation. Nothing here has been executed, installed, published, or qualified. Do not run a direct test/build/SQL fallback while the protected pipeline remains unavailable.

## Change and preserved boundary

The existing exact-scope and all-scope queries retain older unresolved union runs, but forget an older run as soon as it becomes complete. A one-attempt remainder can therefore complete the old week, return, and on the next call select the just-closed week while skipping an intermediate week that never received a run.

`supabase/accounting/weekly-v3/components/20260914162000_no_floor_union_completion_preserves_contiguous_work.sql` changes only those two discovery expressions. Without an explicit floor, a successful `accounting_version=3` completion remains an observed starting run. Taking the minimum of known qualifying starts makes missing intervals between an older known run and a later complete book reachable. The existing scheduler must recheck all actual completion witnesses, source quality and P&L; the proposal adds no synthetic payment success or shortcut around those checks.

An explicit clean floor is unchanged. Legacy/versionless completions do not establish a new historical boundary. With no known qualifying start, the current just-closed-week behavior remains. Unknown history before the first observed run is still unknown. No rate, cash flow, invoice, baseline, earning date, membership or issued record changes. There is no new payer, table, cursor or scheduler.

The proposal preserves a full historical scan, so the completed-prefix liveness concern in the companion audit remains unresolved. It does not fix the older standalone due-gate asymmetry, exact-04:00 wakeup promise, or period-lock cutoff case. These are separate findings, not implicitly completed by this successor.

## Exact preimage design

The final private coordinator hash has not been measured under protected execution, so this proposal does not invent one. It embeds every exact final fairness transformation, reverses them in an explicit order with exact occurrence counts, reverses the P&L skip-predicate addition, and compares the full reconstructed definition against the previously measured J definition MD5 `63f8248cd6d804f450a0b8f0fbc05e77`.

This verifies the removed dispatch text itself; it does not merely delete arbitrary text between anchors. Unchanged final bytes outside the embedded additions remain covered by the reconstructed whole-definition hash. The public wrapper is independently checked against measured MD5 `5aec6700bf043463e9db2933ca63bca1`. Owner `postgres`, SECURITY DEFINER/search_path, approved registry state, private API access and the fairness visitation column are checked. The resulting definition must differ only by the two reversible query replacements.

The exact errors are:

- `union_continuation_authority_preimage_changed`: owner/configuration, wrapper, private execution, registration or visitation predecessor differs.
- `union_continuation_function_preimage_changed`: an embedded final transformation or reconstructed J definition differs, including a second application.
- `union_continuation_patch_anchor_changed`: either requested discovery replacement is not unique.
- `union_continuation_patch_not_reversible`: emitted definition cannot be reversed to the exact observed predecessor.

The source guard is a qualification requirement, not a proven parser/deparser result. Protected execution must demonstrate it against the actual final captured 24-component catalog. The successor is integrated in a separately sealed source candidate and still requires that exact native qualification; do not edit earlier components to accommodate a guard failure.

## Authored fixture

`load.sql` and `regression.sql` are inputs for a protected disposable PostgreSQL 17 fixture. They use the existing fairness unit fixture and its actual private coordinator, cascade, R2/R3, conservation, period and statement functions. They are not a full catalog replacement.

The protected owner must provide a fresh database, `postgres` ownership, the pinned CA source path as psql variable `accounting_source_root`, readonly providers, admitted scratch/output storage and an approved execution identity. The loader reads the sealed fairness fixture by that path. It restores only that fixture's clock substitution, applies the successor's exact final-function guard, then reinstates the clock seam. Do not disable the hash guard or supply a fixture-only replacement hash.

Dependency limits inherited from the unit loader remain explicit: P&L returns ready from a declared fixture helper; the underlying calculator has its existing synthetic request seam; R1 is a zero-only synthetic receipt reader. The new R1 seam requires the exact union/week zero-close record and refuses any member club or recognized earning source. Empty union books execute the real downstream stages and conservation checks, but no cash is paid. The fixture cutover is moved to August 24 only within the disposable empty-source catalog so three past weeks can be exercised. None of these values is a proposed production backfill or P&L certification. The protected execution date must be after September 14, 2026, since actual statement functions retain their closed-week `now()` check.

Ordered payload:

1. Load the sealed fixture through this directory's `load.sql` in a fresh protected database, with the source-root variable bound to the exact admitted checkout. Preserve any preimage failure as a failure.
2. Run `regression.sql` in that database. Each scenario uses its own transaction and rolls back to the common synthetic baseline.
3. Preserve complete logs, assertion count, actual function definitions/ACLs, source identities and independent stopped-process evidence. Do not change UNRUN from a summary or anticipated count.

The authored cases exercise:

- Older failed union succeeds with one remaining shared attempt; the next two calls complete the immediately following weeks.
- Exact-scope continuation from a latest previously completed version 3 book after a missed wakeup.
- A successful current book does not hide an unattempted middle week after an older known completed start.
- Actual zero route receipts, conservation and settled period objects match the run history; replay changes no payment/document artifacts or attempts.
- An unresolved oldest refusal remains first and deduplicates its unchanged alert.
- Explicit clean floors preserve excluded history exactly.
- Legacy completion does not authorize earlier history; no known starting run retains the original default.
- The shared attempt budget and deadline setting are restored; engine checks and private execution grants are unchanged.

## Additional protected preimage acceptance

Before integrating this output into a new financial package, qualify these independent disposable cases against the full actual 24-component candidate, before any clock or dependency seam:

1. Untouched final predecessor accepts the successor. Capture both observed definition hashes and exact owner/ACL state; assert all differences are the two reviewed query clauses.
2. A harmless comment added inside the all-scope dispatch fails with `union_continuation_function_preimage_changed` and rolls the entire transaction back. This targets bytes that the reverse guard removes.
3. A harmless comment changed outside the fairness additions also fails with that error, proving the reconstructed whole-definition check.
4. Reapplying the successor fails and preserves the already-installed successor body/ACL/data exactly.
5. A changed public wrapper or unexpected effective service EXECUTE fails with `union_continuation_authority_preimage_changed` before any mutation.
6. Append this successor to a newly bound full activation candidate and prove a forced late guard failure restores the original whole bundle. The sealed 24-component acceptance receipt, if later obtained, cannot be reused as proof for the successor.

These full-catalog negative cases are precise acceptance requirements; no new executable runner for them is claimed here. Root owns runner, manifest, fixture binding and source-custody integration. Final DST, real full-week financial progress, source/P&L certification and live scheduled reconciliation remain separately required.

Independent source review found two fixture proof gaps. The nullable receipt predicate now uses IS TRUE, and the replay snapshot includes exact union wallets, closes, periods, rounds and run rows, excluding only scheduler visitation. Those corrections were independently read back before relocation. The loader relocation changes only the include path to the canonical component; no duplicate SQL implementation is stored here. All cases remain UNRUN.
