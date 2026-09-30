# Diamond Phase 10: A Diamond Correction Settles Once

Status: Phase 10 line 4's audited adjustments (item 7 of the build list in `docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md`) are built and live, and refuse by name until Dan says what pays for a correction. No page yet; the staff surface is a separate piece. The switches stay off.

## The Database

Migration `a_diamond_correction_settles_once` (applied as `20260929220000`; stored text byte-identical to the repo file, md5 `a68139f582f85c07ab647f70d70ac69f`):

- `ca_diamond_correction_source` (new): what pays for a Diamond correction. One row or none, written by a values migration that quotes Dan. No row is written. `diamond_house`: the house pays a player credit and takes a player debit (a house burn and a player mint on the register, or a player burn and a house mint). `new_issuance`: a credit is minted to the player, a debit retired. A house row moves against the register under either.
- `ca_diamond_adjustment_receipts` (new): one immutable receipt per settled Diamond adjustment, keyed by the adjustment.
- `fn_ca_diamond_adjustment_settle(p_adjustment_id uuid)` (new, platform staff): settles an approved `diamond_wallet` or `diamond_house` row exactly once through `fn_ca_mint` / `fn_ca_burn` as the signed-in staff member, writes the receipt and marks the row settled in one sub-transaction. A replay returns the same receipt and moves nothing. Refusals by name: `platform_staff_only`, `not_found`, `not_a_diamond_adjustment`, `not_approved`, `settled_without_a_receipt`, `diamond_correction_source_not_authorized`, and any Mint refusal under the Mint's own name (for example `that_would_take_the_house_below_zero`).
- `fn_ca_diamond_adjustment_propose(p_target_kind text, p_target_id uuid, p_amount numeric, p_reason text)`, `fn_ca_diamond_adjustment_approve(p_adjustment_id uuid, p_note text DEFAULT NULL)`, `fn_ca_diamond_adjustment_reject(p_adjustment_id uuid, p_note text DEFAULT NULL)` (new, platform staff): the register's own three functions for Diamond rows only, the signed-in caller always the proposer, approver or rejecter. The register's rule that nobody approves their own proposal is unchanged; `ca_operator_policy` is not touched.

Pinned and unchanged: `fn_ca_propose_manual_adjustment`, `fn_ca_approve_manual_adjustment`, `fn_ca_reject_manual_adjustment`, `fn_ca_mint`, `fn_ca_burn`.

## The Client

`src/services/DiamondAdjustmentService.ts`: `proposeDiamondAdjustment`, `approveDiamondAdjustment`, `rejectDiamondAdjustment`, `settleDiamondAdjustment`, typed, each passing a refusal through under the database's name.

## The Rehearsal

One rolled-back transaction through the four doors as a signed-in player and signed-in staff call them (four certification fixtures, two made staff inside the transaction). A player who is not staff was refused at all four doors. Staff A proposed seven rows as themselves; seven bad requests were refused by name, including A approving A's own row (`four_eyes_violated`). Staff B approved six. Chip, still-open, rejected and unknown rows were refused by name. With no source authorized, a settle was refused by name and nothing moved. With `diamond_house` authorized for the rehearsal only: the house held 0, so a 25 credit was refused by name and the row stayed approved; an approved house row of 40 minted into the house; the 25 credit then settled as a house burn and a player mint (supply unchanged); settling it again returned the same receipt and moved nothing; a 10 debit settled as a player burn and a house mint. With `new_issuance`: a 7 credit minted, a 3 debit and a 5 house debit retired. Six immutable receipts, every leg run as the settling staff member, and the supply identity 0.00 before and after (players + house + custody = register).

## Dan's Questions

1. What pays for a Diamond correction: the Diamond house (0 today, funded first by an approved house row) or newly minted Diamonds recorded in the register? Until he answers, every settlement is refused by name.
2. Whether a second person must approve: as built, the register's existing rule applies (the approver can never be the proposer), and the approvals setting is unchanged.

Law: a-diamond-correction-settles-once.
