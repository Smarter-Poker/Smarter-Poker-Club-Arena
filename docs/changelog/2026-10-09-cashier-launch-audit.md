# Club Arena Cashier Launch Audit

Date: 2026-10-09. Branch `audit/cashier-launch-20261009` on `origin/main` 3bfc46f877. One section per finding fixed in this round; the finding ids are those of the audit reports (P pages, D dialogs, R renders, L live, S services and database wiring).

<!-- release evidence to be filled by the parent -->

## Decision: The Cashout V2 Family Is Live And The Migrations Directory Holds No Mirror

The only cashout writers production serves are `fn_cashout_request_v2`, `fn_cashout_approve_v2` and `fn_cashout_release_v2` (plus the reader `fn_cashout_operation_receipt_v2`), defined in `supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql`. They were installed on production on 2026-09-14, the legacy writers were retired to `cashier_v2_intent_required` tombstones the same day, and the live bodies were read on 2026-10-09 with the hashes recorded under S-02 below. By decision the `supabase/migrations` directory intentionally holds no mirror of that component. `scripts/verification-harness/cashier-release-contract.sql` now pins the three writers, so the post deploy canary is the repo side proof that the audited bodies are the ones serving money. No migration and no DDL was written in this round.

## Findings Fixed

### S-01 High: CashoutService mapped every server refusal of a cashout to an unknown outcome

`mutateCashout` now branches on the SQLSTATE the server raised. 22023 (`cashier_invalid_amount`, `cashier_operation_conflict`, `cashier_request_intent_mismatch`) is "That Cashout Request Is Not Valid."; 23514 is read by token: `cashier_wallet_balance_unverified` is "Not Enough Chips For That Cashout.", `cashier_pending_request_exists` is "You Already Have A Pending Cashout.", `cashier_request_already_terminal` is "That Cashout Was Already Decided.", any other 23514 token is "That Cashout Was Refused."; 42501 is "You Are Not Allowed To Do That Here.". These throw the new `CashoutRefusedError` (`definitive: true`, with `code`, `token`, `operationId`, `clubId`, `cashoutId`) because a RAISE rolls the whole transaction back and no event row exists for the op id. `CashoutOutcomeUnknownError` is kept only for transport throws, 57014, 40001, 08xxx, codeless errors and unrecognised codes. The runner in `src/services/CashoutOperation.ts` still needs to acknowledge the durable generation on a `CashoutRefusedError` so the next edit mints a new id (patch handed to the parent; that file is outside this fixer's ownership).

Files: `src/services/CashoutService.ts`, `tests/unit/CashoutService.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-02 High: The live cashout v2 writers were defined only in an unapplied labelled component and pinned nowhere

Decision recorded here: the cashout v2 family (`fn_cashout_request_v2`, `fn_cashout_approve_v2`, `fn_cashout_release_v2`, `fn_cashout_operation_receipt_v2`) is live on production, installed 2026-09-14 and verified 2026-10-09 by `md5(pg_get_functiondef)` (07cf5457edf315929b07316c07be313d, 6fecd34df575557d81966dc1166a2fc4, 3122994e23d96770a2f50e4fe6a191a6, c9af51f246a9be79c7b79c49b760e9a9). The `supabase/migrations` directory intentionally holds no mirror of component33. The release contract now pins the three browser callable writers by those hashes; the receipt reader lacks service_role EXECUTE on production and is listed in the contract as not pinnable until that grant exists. The component header, `supabase/accounting/weekly-v3/README.md` and `tests/fixtures/cashier-document-authority/README.md` no longer say UNRUN, UNAPPLIED or SOURCE ONLY about the installed component (the fixture README's remaining UNRUN lines describe its authored regression cases, which is still true). No migration was written.

Files: `scripts/verification-harness/cashier-release-contract.sql`, `supabase/accounting/weekly-v3/README.md`, `supabase/accounting/weekly-v3/components/20260914164700_cashier_cashout_documents_share_the_existing_invoice_authority.sql`, `tests/fixtures/cashier-document-authority/README.md`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-03 High: WalletService.mintChips minted a fresh idempotency key on every call

Fixed by the WalletService, store and hooks fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`, `src/services/WalletService.ts`, `src/stores/useWalletStore.ts`, `tests/unit/WalletService.test.ts`, `tests/unit/useWalletStore.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### S-04 High: The Club Bank and Promo ledger CSV export had no formula injection escaping

Fixed by the WalletService, store and hooks fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### S-05 Medium: Sign out purged the unresolved money journals

`clearUserCaches` no longer purges `CASHIER_RECOVERY_PREFIX`, `CASHIER_REQUEST_RECOVERY_PREFIX` or `UNION_WALLET_RECOVERY_PREFIX`; they are declared in the new `UNRESOLVED_MONEY_JOURNAL_PREFIXES` and skipped by the prefix loop even if re-added. Each reader (`CashierResilience.isValidRecovery`, `isValidChipRequestRecovery`, `UnionWalletRecovery.validRecordShape`) was read and already refuses a record whose user id is not the scope's user id, so another account on the same device cannot read or replay them.

Files: `src/services/UnionWalletRecovery.ts`, `src/utils/clearUserCaches.ts`, `tests/unit/clearUserCaches.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-06 Medium: The batch send retry fingerprint depended on a mutable display name

Fixed by the WalletService, store and hooks fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### S-07 Medium: Club Bank and promo pot were read straight off clubs columns every API caller can select

`readCashierBalances` reads the club name, union flag, Club Bank (`club_treasury`) and promo pot (`club_promo_wallet`) through `fn_club_money_panel`, the SECURITY DEFINER read with a server role check that DynamicWallet already uses, instead of selecting `clubs.chip_treasury` and `clubs.promo_balance`. A panel error, a non object payload or `authorized: false` throws, so the modal shows Unavailable and never 0. The snapshot gains `hasFloat` (D-16): false when the viewer has no `agents` row (bank and promo float then read 0 with the flag), true when the row exists, null when the float was not read. Remaining direct reads of `clubs.chip_treasury` elsewhere in src are listed in the fixer report for the parent (ChipTransferModal, ClubHomePage, ClubsService); the column level REVOKE belongs to a later migration round.

Files: `scripts/verification-harness/cashier-release-contract.sql`, `src/components/wallet/ChipMintModal.tsx`, `src/services/cashierBalanceRead.ts`, `tests/union-promo-goes-to-the-promo-wallet.law.test.ts`, `tests/unit/cashierBalanceRead.test.ts`, `tests/unit/discardedErrorReadRatchet.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-08 Medium: CashoutService legacy money wrappers minted a decorative op id when the caller omitted it

The dead `sendChipsToPlayer`, `claimBackSend` and `adminRemovePlayerChips` wrappers (two of which minted `newOpId()` when the caller omitted the key) were deleted from CashoutService along with `unwrap` and `CashoutRpcResult`; no caller in src existed. The three tests that exercised them now pin their absence. `WalletService.disbursePromo` still mints its own uuid per call; the exact patch for that file is in the fixer report because it belongs to another fixer.

Files: `src/services/CashoutService.ts`, `tests/cashout-escrow-flow.test.ts`, `tests/money-rules-live-in-the-database.test.ts`, `tests/unit/CashoutService.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-09 Low: A statement export that was already being prepared was reported as expired

Fixed by the WalletService, store and hooks fixer; see the cited files for the change and its regression test.

Files: `src/hooks/useCashierStatement.ts`, `tests/unit/useCashierStatement.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### S-10 Low: UnionWalletRecovery expired an unknown outcome intent after 24 hours

`UnionWalletRecovery.readRecord` no longer evicts a record older than 24 hours, so `reserveUnionWalletOperation` returns the original operation id for the same intent however old it is and only `clearUnionWalletOperation` (a server confirmed receipt) retires it. This matches `CashierResilience`, which never evicted by age.

Files: `src/services/UnionWalletRecovery.ts`, `tests/unit/UnionWalletRecovery.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-11 Low: Dead and stub code in the services slice

Deleted the throw only `completeCashout`, `expireStale` and `removeChipsFromPlayer` stubs in CashoutService, the unreachable cashout note spreads in `AgentWalletIntent.reserveAgentWalletOperation` and `runAgentWalletOperation` (both refuse cashout kinds before the digest; the key schema for live kinds is pinned byte for byte by a new test), the `console.debug` in `CashierOperationsTelemetry` (a refused telemetry row now goes to `reportError`), and the unused `useWallet` hook in `src/hooks/index.ts` (no importer; it summed BUSINESS, PLAYER and PROMO and re-exported the retired store operations). The test that pinned `useWallet().refresh()` now pins that `hooks/index.ts` holds no `loadBalances` call at all. Store and WalletService dead paths were handled by the WalletService fixer.

Files: `src/hooks/index.ts`, `src/stores/useWalletStore.ts`, `tests/balance-events-force-a-refetch.test.ts`, `tests/cashout-escrow-flow.test.ts`, `tests/unit/AgentWalletIntent.test.ts`, `tests/unit/CashierOperationsTelemetry.test.ts`, `tests/unit/CashoutService.test.ts`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### S-12 Low: Release contract pinned by signature only and missed the DO block rewritten bodies

The release contract pins `fn_club_bank_ledger(uuid,integer,integer,text[])` to its live 20260903121500 DO block rewrite (39ff91f5cc60c6300942f51e4ab2c3bb) and every other client called cashier RPC that production grants to authenticated and service_role: fn_cashout_request_v2, fn_cashout_approve_v2, fn_cashout_release_v2, fn_cashout_queue, fn_agent_wallet_reversible, fn_agent_wallet_self_stake, fn_respond_chip_request, fn_redeem_tournament_ticket, fn_cancel_tournament_ticket, fn_promo_wallet_ledger, fn_my_wallet_ledger, fn_ca_chip_statement_page, fn_club_money_panel, fn_mint_chips_from_diamonds, fn_promo_disburse, fn_player_spendable_balance, fn_union_send_to_member, fn_union_player_directory, fn_union_clawback_from_club, fn_union_clawback_promo_from_club and fn_diamond_spin_statements, 22 new entries with the production hashes read on 2026-10-09. Entries whose production proconfig pins `search_path=public` or `search_path=public, extensions` carry that exact value in a new optional `search_path` key; the loop checks the exact installed value and the 23 existing entries are untouched. fn_cashout_operation_receipt_v2 and send_wallet_diamond_transfer are recorded in a comment as not pinnable until service_role is granted.

Files: `scripts/verification-harness/cashier-release-contract.sql`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### D-01 High: Escape inside the stacked Chip Mint closed the Club Bank cashier underneath it mid mint

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-02 High: The painted top right X on the Club Bank cashier bypassed the in flight guard

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-03 Medium: Cross club leakage when the Club Bank cashier was reused

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-04 Medium: Claim Back holder figure and cap went stale after a claim

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-05 Medium: PlayerWalletModal painted a stale club statement over the current one

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/PlayerWalletModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-06 Medium: UnionWalletModal ledger read had no scope guard

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/union/UnionWalletModal.tsx`, `tests/union-wallet-modal.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-07 Medium: UnionWalletModal member sends accepted sub cent and over balance amounts client side

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/union/UnionWalletModal.tsx`, `tests/union-wallet-modal.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-08 Medium: ChipStatement printed two empty painted plates

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/ChipStatement.css`, `src/components/wallet/ChipStatement.tsx`, `tests/unit/ChipStatement.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-09 Medium: The in table Cashier painted controls were under 44px on a phone

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/table/AddOnModal.css`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-10 Medium: Table CashierModal asserted Nothing Was Moved for a transport failure

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/table/CashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-11 Medium: No Tab trap, focus in or focus return on four money dialogs

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/union/UnionWalletModal.tsx`, `src/components/wallet/ChipMintModal.tsx`, `src/components/wallet/PlayerWalletModal.tsx`, `src/components/wallet/WalletCashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-13 Medium: DiamondWalletModal closed freely while a diamond transfer was in flight

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/DiamondWalletModal.tsx`, `src/components/wallet/DiamondWalletTransfer.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-14 Medium: ClubQuickLinkTile directory on the shark family had one painted plate and no label

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/home/ClubQuickLinkTile.tsx`, `tests/components/ClubQuickLinkTile.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-15 Low: Number parsing accepted exponent notation on every amount field

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/union/UnionWalletModal.tsx`, `src/components/wallet/ChipMintModal.tsx`, `src/components/wallet/DiamondWalletTransfer.tsx`, `src/components/wallet/WalletCashierModal.tsx`, `tests/union-wallet-modal.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-16 Low: The Agent Wallet cashier printed Unavailable for a viewer who simply has no agents row

See S-07: `readCashierBalances` exposes `hasFloat` so the Agent Wallet row can say "No Agent Float Yet" instead of "Unavailable" when the viewer simply has no agents row. Release integration: `WalletCashierModal` now keeps the flag in state (cleared on reopen and on a failed read) and, on the `agent_wallet` cashier, prints "No Agent Float Yet" in the balance plate when the snapshot says `hasFloat === false`; the RTL case in `tests/components/cashier-dialogs-launch-audit.test.tsx` pins the words, that "Unavailable" is absent and that no invented 0 is printed.

Files: `src/services/cashierBalanceRead.ts`, `src/components/wallet/WalletCashierModal.tsx`, `tests/components/cashier-dialogs-launch-audit.test.tsx`

Verification: the unit and law suites named above pass under `npx vitest run` on this branch (services fixer gate log `$HOME/tmp-claude/audit1009/fxd-gates.log`); `npx tsc --noEmit -p tsconfig.app.json` reports no errors for the services slice; `python3 scripts/ci/verify-source-bindings.py`, `python3 -m unittest discover -s scripts/ci -p test_cash_native_pgcron.py` and `tests/every-pinned-source-stays-bound.law.test.ts` pass after the restamps recorded in `tests/fixtures/full-weekly-accounting/source-binding.json`.

### D-17 Low: Dead CSS and dead code in the dialogs

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/table/CashierModal.css`, `src/components/wallet/DiamondWalletModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-19 Low: Copy that was not Title Case in AgentCashoutPanel

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/agent/AgentCashoutPanel.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-21 Low: AgentCashoutPanel processing was a single id while inFlightRef was per card

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/agent/AgentCashoutPanel.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-22 Low: Table CashierModal clamped silently while typing and aria-invalid could never be true

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/table/CashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### D-23 Low: The Realtime filter in CashoutRequestModal was player scoped, not club scoped

Fixed by the dialogs fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/CashoutRequestModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### L-03 Low: The Trade Cashier and Full Statement pages never set document.title

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `tests/cashier-club-arena-console.law.test.ts`, `tests/cashier-statements-page.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-01 High: CashierPage swallowed a failed role read and painted a default cashier

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-02 High: A stale CashierPage load cleared the loading context of the next club

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-03 Medium: The Claim Back list on the Trade page had no stale response guard

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-04 Medium: Amount inputs accepted more than two decimals on the classic cashier

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`, `tests/cashier-club-arena-console.law.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-05 Medium: The high value Send confirm dialog had no focus management

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.module.css`, `src/pages/CashierPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-06 Medium: The Buy In tab on the classic cashier was a dead end

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-07 Medium: The Send tab offered the viewer as a recipient

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-08 Medium: Switching clubs from the classic cashier exited the classic cashier

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/components/club/CashierClubSwitcher.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-09 Medium: The Settlement Record printed exact decimals against the console law

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `tests/cashier-club-arena-console.law.test.ts`, `tests/cashier-weekly-statements.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-10 Medium: Money copy on the Trade and classic pages broke the console copy rules

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-11 Medium: Player Wallet word controls were under the 44px touch minimum

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/PlayerWalletPage.css`, `tests/cashier-club-arena-console.law.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-14 Low: Dead and contradictory code on CashierPage

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`, `tests/unit/CashierAmountValidation.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-15 Low: Static strings that were not Title Case for assistive technology

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/PlayerWalletPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-16 Low: Float sums for displayed money on the Trade page

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-17 Low: A Trade page badge was capped by the page

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-18 Low: Duplicate full reloads on the Trade page

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-20 Low: Input parsing messages on both cashier pages

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierPage.tsx`, `src/pages/CashierTradePage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### P-24 Low: PlayerWalletPage fmtNum dropped trailing zeros and allowed three fraction digits

Fixed by the pages fixer; see the cited files for the change and its regression test.

Files: `src/pages/PlayerWalletPage.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-01 High: The cashier quick link directory opened on the shark console with an empty painted plate

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/home/ClubQuickLinkTile.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-02 High: Chip Statement was on the riveted master with two empty painted plates

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/ChipStatement.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-03 High: DynamicWallet printed 0 for every wallet when its first read failed

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/DynamicWallet.tsx`, `tests/components/DynamicWalletVisibleReads.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-04 Medium: The Diamond Wallet error state showed a raw browser button

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/DiamondWalletModal.css`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-05 Medium: The in table Cashier printed its Recent ledger and errors below the painted frame

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/table/CashierModal.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-06 Medium: The Trade page sticky dock and Claim Back band were a darker tone than the console glass

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierTradePage.module.css`, `tests/cashier-club-arena-console.law.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-07 Medium: DynamicWallet still drew rounded chrome in CSS

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/wallet/DynamicWallet.css`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-08 Medium: Settlement Record rows printed cents on a forward facing page

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `tests/cashier-club-arena-console.law.test.ts`, `tests/cashier-weekly-statements.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-09 Low: The agent cashout desk printed lower case relative times and a font glyph refresh icon

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/components/agent/AgentCashoutPanel.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-11 Low: The statement entry kind buyin printed as Buyin

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierStatementsPage.tsx`, `tests/cashier-statements-page.test.tsx`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

### R-12 Low: Word controls narrower than 44px on the statements and Trade pages

Fixed by the renders fixer; see the cited files for the change and its regression test.

Files: `src/pages/CashierStatementsPage.module.css`, `src/pages/CashierTradePage.module.css`, `tests/cashier-club-arena-console.law.test.ts`

Verification: the owning fixer's vitest, eslint and tsc runs are logged under `$HOME/tmp-claude/audit1009/` (fxa, fxb, fxc logs); the parent's combined gate run on the merged worktree is the release evidence.

## Release Integration: Cross Owner Patches

Four patches the fixers handed to the parent because the file belonged to another owner were applied on the combined tree before the gates below ran.

### S-01 follow-through: the cashout runner acknowledges a definitive refusal

`runCashoutOperation` in `src/services/CashoutOperation.ts` awaits the submission in a try/catch: when the service rejects with `CashoutRefusedError` and the captured start is still current, it awaits `acknowledgeAgentCashoutStart(admitted)` before rethrowing, so the durable generation is retired and the next edit mints a fresh operation id instead of replaying a receipt lookup for an operation the server rolled back. Unknown outcomes are untouched and stay unacknowledged. `tests/unit/CashoutOperation.test.ts` adds the case: rpc resolves `{data:null,error:{code:'23514',message:'cashier_wallet_balance_unverified'}}`, the caller sees "Not Enough Chips For That Cashout.", one rpc call, and the generation and its start are acknowledged.

Files: `src/services/CashoutOperation.ts`, `tests/unit/CashoutOperation.test.ts`, `tests/fixtures/full-weekly-accounting/source-binding.json` (restamp recorded in `cashier_launch_audit_rebinding_20261009`)

### S-08 follow-through: promo disbursement carries the caller's retained operation id

`WalletService.disbursePromo(clubId, playerId, amount, note, opId)` requires a caller retained UUID (`Promo Disbursement Requires A Retained Operation Id` otherwise) instead of minting `uuid()` per call, which protected nothing against commit + lost response + retry. `AgentDashboardPage` holds `promoOpIdRef`: minted once per attempt with the shared `uuid()` helper, retained across a failure, cleared after success and whenever the amount or the target agent changes. `bulkDistributePromo` mints one id per row because a bulk caller has no edit to retain across. `tests/unit/WalletService.test.ts` pins that a missing or malformed id is refused before any rpc and that two calls after a refused rpc carry the same `p_op_id`; `tests/unit/PromoPaymentIdentity.test.ts` keeps its lost-response and distinct-identity cases on the new signature.

Files: `src/services/WalletService.ts`, `src/pages/AgentDashboardPage.tsx`, `tests/unit/WalletService.test.ts`, `tests/unit/PromoPaymentIdentity.test.ts`

### S-07 follow-through: ChipTransferModal reads the treasury through the money panel

The bank-role sender balance in `src/components/agent/ChipTransferModal.tsx` comes from `supabase.rpc('fn_club_money_panel', { p_club_id })` reading `club_treasury`, the same role-checked read `cashierBalanceRead.ts` uses, instead of a direct `clubs.select('chip_treasury')`. An rpc error (reported through `reportError`), `authorized: false` or an absent figure leaves the balance unknown, never 0, and the Confirm control stays disabled while the balance is unknown. `tests/components/chip-transfer-modal-knows-both-ends.test.tsx` answers the panel in its harness and adds the four cases (panel read; refusal, error and null figure each print Unknown and keep Confirm closed). `tests/unit/UnknownBalanceIsNotZero.test.ts` moves its mechanism pin from `if (!bankErr) setSenderBalance(` to the authorized panel read and the `Number.isFinite` guard; the rule it enforces is unchanged.

Files: `src/components/agent/ChipTransferModal.tsx`, `tests/components/chip-transfer-modal-knows-both-ends.test.tsx`, `tests/unit/UnknownBalanceIsNotZero.test.ts`

### D-16 follow-through

See D-16 above: the Agent Wallet cashier now consumes `hasFloat`.

## Not Fixed In This Round

S-02's migration mirror (deliberately not written, see the decision above) and the column level REVOKE on `clubs.chip_treasury` and `clubs.promo_balance` (S-07, needs DDL; `ClubHomePage` and `ClubsService` still select the column directly) are deferred to a follow-up that carries DDL.
