# FIFO5 unfinished Spin history retention

Status: SOURCE ONLY, UNRUN, UNINSTALLED. This is preventive source for the existing `sp_prune_hand_history(integer)` transaction. It does not restore missing history, admit a mixed settlement basis, assign places, pay anyone, or establish the original 22-alert membership.

## Change and preserved behavior

The exact captured full function definition MD5 is `03f156a50f882354f7d09f30fe08afd2`; the candidate full definition MD5 is `8a5858c8586296d772add9e233abc269`. These are `md5(pg_get_functiondef(...))`, not body-only hashes. The forward and rollback files embed the captured preimage and derive the one candidate insertion using an exact, unique anchor. They accept only the two complete known images and independently check owner, ACL, function metadata and the new private receipt dependencies before and after replacement. They do not write rows, grant privileges, create a function/table, or alter a schedule. Exact replay is supported. Rollback restores the original eligibility and cannot reconstruct deleted records; it also restores the old deletion risk.

Eligibility is evaluated inside the existing candidate CTE, before the batch limit, row locks and all four child/history deletions. Known Spin history stays excluded until its current parent is completed with a canonical terminal receipt, or cancelled with a canonical cancellation receipt. The parent is obtained through the current table ownership; a conflicting non-null history parent, missing parent or missing/blank tournament classification excludes deletion. This does not depend on a first settlement receipt having appeared, so no new absent-receipt race or lock namespace is introduced. The pruner retains its existing history-before-atomic lock/deletion order, 20-second budget, age policy, batching, horse checks and reported/BBJ/outbox/pending-knockout exclusions.

The v4 correction places both nonempty classification conditions outside every tournament branch. A terminal or cancellation receipt therefore cannot bypass a NULL/blank variant or type. `variant` and `tournament_type` are nullable text with no exhaustive captured vocabulary constraint: this is **not** validation of every unknown nonempty string. The existing proposal's exact case-insensitive Spin comparisons are retained; no invented enum or whitespace normalization is claimed. A cash history with both parent identities NULL remains eligible under the original remaining rules. Recognized non-Spin-by-these-comparisons history retains the original remaining rules.

The private receipt guards bind ordinary table kind, postgres ownership, owner-only ACL, RLS state, absence of policies/column grants, validated primary key and the exact enabled immutable trigger/handler. They do not invent receipts or bypass the canonical completion/cancellation writers. Source replacement still needs the existing owner DDL serialization boundary; read/replace/read is not proof against a concurrent owner DDL replacement.

## Genuine provider inputs and exact stage order

This v2 is SOURCE ONLY / UNRUN. The original v1 source manifest and every byte it pinned are preserved in `operational-alert-routing/evidence/helper-alert-intake-fifo5-retention-source-v1-20260917/`. The forward/rollback runtime bytes are unchanged.

Within each existing independent Spin allocation, after the existing schema, access, policies, source authority and empty-provider checks, and **before** `real_funded_paid_seat_fixture`, use the following stages:

1. As the existing `fixture_bootstrap` provider session, run `fixtures/spin-history-retention/provider-supplement.sql` with `execution_uuid`. Its transaction includes `sequence-authority.sql`, `provider-closure.sql` (which includes `provider-closure-check.sql`), and `provider-check.sql` before commit. Do not run it twice; it deliberately requires absent additional provider objects.
2. As the actual nonsuper `postgres` session, run `spin-history-retention.sql` with `execution_uuid` and `tournament_uuid`. It includes `component-inputs.sql`, the unchanged sibling `spin-expiry-business-state.sql`, and `state.sql`. All catalog controls roll back.
3. As actual nonsuper `postgres`, run `spin-history-retention-behavior.sql` with `execution_uuid`, `ordinary_user_uuid`, and `tournament_uuid`, and the existing `qualification.execution_uuid` setting. It includes `database-state.sql`, `component-inputs.sql`, and `estate.sql`. Its entire estate, business calls, pruner calls and catalog changes roll back. Require its final JSON receipt; a successful connection or intermediate SELECT is insufficient.
4. Continue the unchanged existing real funded fixture, natural-age check and R1/R5/R2 stages. No retention history may enter that estate.

All includes are relative to the file which contains them. Stage every file pinned by this manifest at its repository-relative path; the unchanged `spin-expiry-business-state.sql` remains a required existing input. The source files do not create another runner, scheduler or allocation framework.

The initial provider capture at 2026-09-17 06:55:37.254267 UTC binds the actual retention policy and projection outbox schemas, constraints, indexes, RLS, ACLs and real outbox triggers. `provider-authority.json` retains it; `provider-check.sql` compares complete selected catalog projections. The existing cancellation receipt table remains the base provider's exact guarded input.

The focused 07:10:07.424003 UTC capture supplies authentic `table_pending_addons` (including its three unvalidated numeric constraints), the current full postcommit delegate `8d18dde12765610895b25e297a1f403f` and actual history projection writer `e7f05bb7d61360be7424c5f429066047`. `provider-closure.sql` restores these exact missing objects and checks their captured authority. The eight real history trigger bindings stay enabled. Their current function catalog is retained in `history-writer-authority.json`; only the base's stale history stats handler is replaced from its exact known preimage with the captured current definition. The unchanged seven handlers and all eight bindings are asserted.

The delegate's BBJ, promo, insurance and addon branches are retained as source authority in the capture but are not restored or qualified as a financial writer graph. This fixture does not create an outbox row, delete one, or invoke those branches. Its history projection writer creates history and actual trigger effects; it is not an accepted hand settlement receipt.

`sequence-authority.sql` restores only the captured `content_authors_id_seq` integer type/bounds, owner, ACL and OWNED BY dependency from the exact bare base preimage, preserving its counter. The capture is 07:18:42.642925 UTC. It supports the actual horse-profile social trigger; the fixture requires the generated author and completed profile, so its exception-catching trigger cannot silently mask missing provider authority. No sequence is restarted or reset. Genuine `nextval` calls during the rollback-only fixture advance counters nontransactionally; the final receipt discloses exact before/after values for the three used sequences. Row/catalog rollback is exact; counter rollback is neither asserted nor attempted.

## Seven-case native behavior source

The estate uses the actual seat-first creator for four empty Spin boards, real active triggers for a cash table and horse-profile transition, and real `atomic_cancel_tournament` for two zero-entry boards. The latter must produce its own exact canonical cancellation receipts, close its tables/escrows, and leave every financial journal and wallet at zero. The fixture never inserts accepted-hand, cancellation or terminal receipts. Cancellation precedes history: the actual cancellation guard rejects played boards. The subsequent histories are explicitly synthetic zero-money delayed projections through the actual owner projection writer, which has no parent-status restriction. They do not establish paid entry, gameplay or successful hand settlement.

The independent oracle expects these outcomes from actual `sp_prune_hand_history(1)` calls:

| Case                                           | Original deletes | Candidate deletes |
| ---------------------------------------------- | ---------------- | ----------------- |
| Unfinished Spin, no first accepted receipt     | yes              | no                |
| NULL variant, no receipt                       | yes              | no                |
| Cash                                           | yes              | yes               |
| Canonically cancelled Spin, delayed projection | yes              | yes               |
| Canonically cancelled but NULL variant         | yes              | no                |
| Reported cash history                          | no               | no                |
| Human cash history                             | no               | no                |

Each image runs in its own forced-rollback subtransaction: original removes exactly five histories; candidate exactly two. The oracle independently filters only the four original pruner deletion relations from a bounded full-row snapshot of every restored auth/public/smarter_private table. No financial or other row change is allowed. Bounds are 400 tables, 1,000 rows per table and 4 MiB serialized state; these are logical admission bounds, not physical memory guarantees. All rows, the exact pruner catalog and enabled user-trigger bindings must be restored after each image and after the outer fixture rollback. Every genuine deferred constraint is forced before the pruner executes.

There is no successful same-category retention native baseline yet. The current seven-case source is unexecuted. Existing expiry/refund successes are different evidence categories. A completed-terminal positive and actual multi-session first-receipt/terminal commit/rollback controls are still pending separate source/native work. A declared synthetic starting estate may be used for the former only if the current actual terminal writer itself creates the receipt with real guards enabled; that would qualify terminal/pruner behavior, not funding or gameplay. A committed shared race estate cannot be claimed rolled back to empty by this single-session fixture; it needs owned disposal within the existing runner's allocation. Remaining original BBJ/outbox/knockout exclusions are unchanged source and have no new behavior pass claim here.

## Existing verification route and remaining wiring

Use the existing `.github/workflows/ci.yml` required `accounting_postgres` job and `python3 scripts/ci/test-spin-expiry-postgres.py`. At base `56115f5239ed735bc238757e4defda45b1edbda4`, those are lines 1083 and 1284. Root owns directly triggered classifier paths, immutable input staging, the exact stages above, verdict parsing and existing allocation/backend cleanup. This helper changed neither runner nor classifier. Current base selection recognizes `spin-expiry-*`, not these new paths, so source existence is not enforcement.

Native execution and output receipts, integrated source pins, required CI, guarded production installation/readback and observed preservation remain required. No source custody claim authorizes partial installation. Preserve current R1/R5/R2 financial assertions and existing time/resource/cleanup boundaries.

## Historical limits

This change prevents a compatible source deletion path; it does not identify which writer deleted historical rows. The known pruner returns an integer and has no unique NOTICE. The supplied successful scheduler rows do not bind their deleted hand identities. The later single-board capture retained 32 legacy receipts but only one history; earlier projected histories cannot recreate missing full rows. None of those observations authorizes restoration, financial closure or a claim that the original FIFO5 cohort was recovered. Frozen v3/v4 proposals and mixed-history v1/v2 remain separate and unchanged.
