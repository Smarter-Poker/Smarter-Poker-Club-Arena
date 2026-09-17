# P&L hook payload prerequisites and ordered execution

**UNRUN.** This document defines source inputs for the protected pipeline owner. It is not an installed execution interface, approved execution UUID, direct-run instruction or fallback authorization. Do not invoke the old local native scripts while the replacement pipeline is unavailable.

## Baseline inputs

Use the root's complete captured actual catalog at `tests/fixtures/full-weekly-accounting/`, not the small schema in this directory:

1. `schema.sql`, then `policies.sql`, `access.sql`, `seed-registry.sql`.
2. Bind `tests/fixtures/pnl-evidence/source-binding.json` and its listed files. `captured-pnl-metadata.json` is the portable unchanged read-only metadata capture, including the original `writers[]` definitions. The authored `verify-wrapper-source-binding.py` checks those source hashes and exact wrapper text, allowing only the outer command terminator required to load `pg_get_functiondef` output. It is **UNRUN**, for protected execution only; its success would establish source custody, not database or authorization behavior.
3. Load `tests/fixtures/pnl-evidence/legacy-pnl-wrapper-preimages.sql` **before the candidate in each independent fresh cluster**. These unchanged actual wrappers were absent from the first dependency closure. That original fixture initially withholds API grants. The later readback at 2026-09-15 01:01:08 UTC captured postgres ownership and exact postgres/service-only EXECUTE grants. The full runner loads `full-weekly-accounting/supplemental-function-access.sql` and its bound JSON after the original definitions to reproduce those observations. Never infer these rights from the core or unrelated `access.sql` entries. Owner-executed hook calls still do not replace a complete client-role matrix or fresh installation-time permission verification.
4. Require the installed safe P&L core preimage `a7eb35f0906ad77fd5eb0975d90023b7`, issuer `aef6d2b4583dafbe291bab39e52953c6`, ECO reader `4bef87530456c7c0d291c59c70eb41cd`, ECO writer `1ce954a9cc4e55ad191e9c40fb4a56d5`, reconciliation authorization `630e87c9842a423e6a5198551623dec0`, and invoice reader `bee79493a9a724e043b658ba328d663f`. Do not overwrite a different baseline to make the hook pass.

These inputs must be pinned and admitted through the protected catalog plan. Existing captured source is evidence, not fresh provider/readiness proof. This payload must run in an isolated, empty disposable database under that plan, with no credentials or connection to production.

## Candidate order and guard proof

Install the root's full approved one-transaction candidate in its declared dependency order. The relevant required subsequence is:

1. J (`20260914142600`) creates the one private scoped coordinator.
2. N cash-refusal preparation gate (`20260914152500`), after the other existing declared components.
3. P&L evidence reader (`20260914150848`). P and N are independent, and the explicit builder order places N before P despite their filename timestamps.
4. P&L hooks (`20260914153000`). Its exact N body/catalog precondition and all measured original preimage guards must execute unchanged.
5. Fairness (`20260914154500`). It must preserve the P&L prior-success condition while verifying its predecessor by reversing only that one exact addition.

Add a separate rejection database: alter one N body byte or a guarded invoice/core/catalog attribute, attempt the whole candidate, and require failure plus unchanged full schema, grants and registry. This is a pending protected case, not prior evidence. Capture definition MD5s after N, P&L hooks, and fairness from the actual database; none is invented by source review.

## Fixture data and regression order

Use `tests/fixtures/tournament-fee-lifecycle/full-lifecycle-seed.sql`. It supplies the synthetic owner/profile `10000000-0000-0000-0000-000000000001`, its standalone club and tournament, but **does not supply a union**. Keep the real lifecycle probes in their existing order. Then load `tests/fixtures/pnl-evidence/hooks-seed.sql`: it requires that owner/profile, creates only the empty synthetic union `00000000-0000-0000-0000-000000700002`, and records the September 7 07:00 UTC supported floor. It creates no membership mapping, commercial agreement, P&L baseline, evidence, invoice, ECO row or payment claim. Its structural seed transaction suppresses creation triggers; the regression uses actual functions with normal triggers restored. This seed is not evidence for union creation authorization.

The wrapper tests require that exact union and no existing P&L claim for it. The weekly wrapper uses minimum hours zero so it reaches the guarded core rather than the too-short skip. The standalone lifecycle club stays independent; no existing template is moved into the test union.

The test identities `00000000-0000-0000-0000-000000700001` (unknown union diagnostic) and `00000000-0000-0000-0000-000000700099` (unauthorized caller) must remain unused by seed authorization. The regression asserts the caller does not own/admin/read any club or union. The clock must be after September 14 07:00 UTC; preserve actual server semantics and never rewrite the financial functions' time checks to force a result.

The root full activation payload uses sequential independent rejection and acceptance clusters. Each loads catalog/access/registry → bound unchanged wrappers and real disabled-launcher cron prerequisites → actual candidate or rejection case. The acceptance cluster then loads lifecycle seed/probes → hook seed → `tests/fixtures/pnl-evidence/hooks-regression.sql`. Do not clone the cron launcher's connected database. Capture hook assertion output separately from the historical 124 tournament assertions; do not relabel an old count as new hook coverage. The hook cases run in a transaction and roll back. Do **not** load the small `pnl-evidence/schema.sql` into the full catalog, and do not substitute mocked issuer, ECO, P&L core, preparation, evidence report or wrapper functions. The older `test-pnl-evidence.sh` exercises only the reader in a small fixture and does not cover these hooks.

The protected combined coordinator qualification must also carry these behavioral cases in its actual receipt/data fixture: previous successful union becomes durably failed when P&L proof is absent, no repeat payment or invoice/ECO rewrite, unchanged failures deduplicate alerts, and a valid independently scoped standalone book still completes using its actual routed/period/payment receipts. Source-order assertions in `hooks-regression.sql` are supplemental; they are not substitutes for those real coordinator cases.

## Required output receipts

Record approved catalog/execution identity, actual fixture/preimage checks, assertion and failure logs, per-stage definition hashes, rejected-candidate rollback proof, actual full-coordinator cases, and independently observed stopped/empty execution state. Source-only SHA256 bindings do not supply measured post-change function hashes or qualified execution of the separately captured wrapper owner/ACL. Until protected admission and those receipts exist, both the new hook and new regression paths remain source-only and unqualified.
