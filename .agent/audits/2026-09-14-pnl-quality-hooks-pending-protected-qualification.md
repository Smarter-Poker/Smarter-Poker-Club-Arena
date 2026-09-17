# P&L quality hooks: source only, protected qualification pending

The current `/Users/smarter.poker/Documents/AGENTS.md` was read before this work resumed. The protected local pipeline is not operational and `sp-native` is proposed, not installed. No tests, builds, GitHub operations, production calls, publication or command fallback were run for this hook. No owned process remains running. The reader's earlier 45 native assertions predate this policy change and do not qualify these hooks.

## Source and ordering

New component: `supabase/accounting/weekly-v3/components/20260914153000_uncertified_union_pnl_blocks_close_and_squareup.sql`.

Required order is the existing J coordinator, the remaining declared components through N cash-refusal preparation gate `20260914152500`, the P&L reader component `20260914150848`, this P&L hook `20260914153000`, and the fairness component `20260914154500`. N and the reader are independent; the explicit builder places N before the reader regardless of filename timestamps. Other declared source dependencies retain the root catalog plan's order. No existing A–Q component body was modified.

N's resulting definition MD5 was not separately captured before the execution policy changed. The hook therefore compares the exact embedded N `prosrc` literal and its signature, return type, volatility, SECURITY DEFINER and search-path contract before replacing it. This is not an invented native hash. Protected qualification must execute that guard against actual N and record the result. The other preimages come from existing readback/catalog evidence:

| Function | Reviewed preimage MD5 |
| --- | --- |
| P&L evidence report | `501b5a243800f96ef549aa4b137bc7bf` |
| Weekly invoice issuer | `aef6d2b4583dafbe291bab39e52953c6` |
| ECO adjustment | `4bef87530456c7c0d291c59c70eb41cd` |
| ECO record | `1ce954a9cc4e55ad191e9c40fb4a56d5` |
| Reconciliation reader authorization dependency | `630e87c9842a423e6a5198551623dec0` |
| J private scoped coordinator | `63f8248cd6d804f450a0b8f0fbc05e77` |
| Safe direct P&L core | `a7eb35f0906ad77fd5eb0975d90023b7` |
| Legacy club invoice reader | `bee79493a9a724e043b658ba328d663f` |

The fairness owner agreed to require the new unique P&L skip predicate, reverse only that exact predicate for comparison with J's measured hash, then preserve the P&L condition in the fairness output. There remains one private coordinator.

## Intended behavior, not yet executed

`fn_union_pnl_close_quality` reads the same frozen diagnostic contract and returns a stable blocked reason plus issue codes, without balances, player identities, source amounts or invoice contents. `fn_require_union_pnl_evidence` raises SQLSTATE 55000 for an uncertified or unsupported period. Both new helpers remain private.

The preparation hook runs only for a union, after original engine authorization, period validation, exact scope/week lock and the durable cash-refusal check, before club discovery, payer locks or period calculations. It returns structured `success=false`, preserving the existing coordinator's durable failure/alert path. Standalone club preparation does not call the union P&L gate.

The private coordinator's previous-success shortcut now also requires P&L quality. A previous v3 rakeback/invoice receipt cannot skip missing P&L capture. When that quality is blocked, the existing run journal reaches normal failed preparation and no financial stage runs. The standalone shortcut is unchanged.

The direct P&L core also checks the same quality after its original engine authorization, window/floor validation and scope locks, before reading a replay claim or creating the temporary calculation. Preview and payment therefore refuse the same uncertified source, including calls through the original guarded and weekly wrappers. Existing claim, baseline and payment rows are untouched. A wrapper's original too-short skipped response remains a skip, not financial completion.

The direct weekly invoice issuer and direct ECO record writer retain their exact original owner/admin denial before the new evidence guard. The ECO adjustment reader checks the same broader authorization predicate inherited from its original reconciliation reader before evaluating evidence. The original reconciliation dependency's MD5 is guarded. Direct `fn_union_club_invoice` depends on the guarded ECO adjustment, so it cannot return a newly calculated false `settled_in_chips` value through that path while evidence is blocked. No issued invoice, historical ECO row, baseline or payment is rewritten by the hook.

Final source review compared those predicates with the captured actual catalog. Preparation and direct P&L core retain the engine gate; issuer and ECO writer retain their owner/admin denial; ECO adjustment copies the exact union owner/admin or member owner/co_owner/admin/super_agent predicate. The inherited null-caller behavior remains unchanged. ECO declaration initializers still read settings/baseline before `BEGIN`, as in the original function, but return no new data. The new helpers themselves have no client EXECUTE grants, including service_role. These are source findings, not executed permission tests or a claim that every legacy entry point's ACL has been captured.

The invoice reader's existing table result has no status or evidence field. It is not safe to return null monetary cells and hope clients distinguish them from zero, nor to substitute posted-payment amounts for uncertified earnings. Its exact original body/dependency is guarded and its call now raises the explicit `union_pnl_basis_uncertified` SQLSTATE 55000 through ECO authorization. There is no successful numeric row or eligibility result on an uncertified basis. A future successful preview API carrying basis/payment status, plus audited consumer handling, remains an interface gap; this change does not pretend that exception handling supplies the missing profit calculation. The underlying raw P&L/reconciliation readers are not upgraded by this hook and must not be promoted back to financial authority.

Source inventory also found `RakebackSettlerService.runUnionEcoRecord` still calling `fn_union_eco_record_current_week`. The guarded ECO writer will refuse an open or uncertified period rather than persisting a computed ECO amount. The server lane and that existing wrapper were not changed here; their retry/error reporting remains a root integration concern.

## Remaining substantive work

The P&L diagnostic deliberately cannot certify a complete source basis. The hooks therefore intentionally block union full accounting until canonical accepted-hand ownership/coverage, exact boundary evidence, tournament earning/instrument/equity evidence and agreed ECO economics are completed. An always-blocked quality check is not a completed P&L feature. The proposed hand-owner capture boundary and precise source gaps are documented in `2026-09-14-pnl-evidence-reader-and-capture-boundary.md`.

No P&L transfer is activated, no rate is invented, and no fake baseline is installed. These refusal hooks prevent an unsupported weekly success; they do not fulfill the remaining accounting calculation/capture requirements.

## Pending protected execution

`tests/fixtures/pnl-evidence/hooks-regression.sql` is new regression source and is **UNRUN**. It is intended for the qualified full actual catalog/component plan, not a new standalone test runner. It includes authorization precedence, issue-only refusal payloads, direct authorized/unauthorized issuance, no invoice/ECO insertion, union preparation refusal, source-order checks before payer work, the prior-success quality condition, actual P&L preview/payment/wrappers and the actual invoice reader. Its transaction rolls fixture changes back. `tests/fixtures/pnl-evidence/PROTECTED-QUALIFICATION.md` gives portable `full-weekly-accounting`/`tournament-fee-lifecycle` inputs, exact ordering and output-receipt requirements. `hooks-seed.sql` adds the union absent from the lifecycle seed without fabricating a baseline or payment. `legacy-pnl-wrapper-preimages.sql` supplies the unchanged captured definitions, not new production writers; `source-binding.json` and the authored UNRUN verifier bind them to the portable original metadata. Those two wrappers lack captured owner/ACL: fixture ownership remains with the disposable loader, all client grants are withheld, and owner-executed behavior does not qualify production wrapper permissions.

The protected owner must additionally integrate these cases into the existing actual coordinator fixture: a previously successful union whose P&L capture is missing must become durably failed without paying again; unchanged retries deduplicate the failure alert; an independent standalone club with actual certified source/period/routing receipts still completes; existing invoice/ECO rows remain byte-identical; N plus P&L reader plus this hook plus fairness are installed in the declared order; and the full component transaction rolls back if any preimage/guard fails. Capture native definition hashes and admission/terminal receipts only through the protected pipeline. No result for those cases is claimed here.
