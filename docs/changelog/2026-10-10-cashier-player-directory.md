# Cashier Players Directory Redesign

Owner request: match the Players page layout/search style, with no large frames.

Scope: routed Trade, Classic and Statements cashiers; preserve wallet dialogs, role scope, amounts, retry identity, reconciliation and ledger/export logic. Client-only delivery, no new engine contract or database change.

Acceptance: unframed wide workspace, compact desktop/mobile typography, full-width roster search with result count, visible selected filters, readable recipient rows; focused search/financial regression checks, compiler, protected merge, static publication and affected live proof.

Checkout: /Volumes/SmarterWork/agent-work/cashier-player-directory-20261010/client
Branch: redesign/cashier-player-directory-20261010
Operation owner: this chat. Other cashier audit checkout is preserved.

Policy 2.9 read 2026-10-10; canonical manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b; owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; reference adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Repository AGENTS, CLAUDE, playbook, publishing, deploy paths and console skill read.

Implementation: page chassis becomes CashierWorkspace, financial confirmation dialogs retain SpadeConsole. Search also matches readable role labels. Existing painted-dialog contracts remain enforced; routed-page contract follows the new owner direction.

Local validation: 14 focused suites, 151 tests passed; app TypeScript passed; all four copy gates passed; canonical policy check and diff whitespace check passed. Desktop 1440px and phone 393px real Trade page renders with isolated synthetic data captured under /Volumes/SmarterArchives/agent-evidence/cashier-player-directory-20261010. Browser role search returned the expected recipient and count, unmatched search displayed its empty message, read failure displayed its alert, and no horizontal overflow was observed. Baseline and temporary harness removed after capture. Full build and protected delivery pending.

Search: readable role labels and number substrings rank consistently with matching; active search relevance survives the Group By Role setting. The page action bar now stays in document flow so it cannot cover search/section controls.
