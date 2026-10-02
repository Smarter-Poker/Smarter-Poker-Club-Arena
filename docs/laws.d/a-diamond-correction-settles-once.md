# tests/a-diamond-correction-settles-once.law.test.ts

A correction to someone's Diamonds is proposed by one staff member, approved
by a different one, and settled once. The register for it,
ca_manual_adjustments, already took a Diamond row (a player's wallet or the
house, whole Diamonds, a reason of at least twenty characters) and already
refused an approver who proposed the row. What it lacked was anywhere for an
approved Diamond row to go: its only settler pays chips.

The rule: one platform-staff door, fn_ca_diamond_adjustment_settle, settles an
approved Diamond row exactly once. It locks the row, answers a settled row with
its stored receipt (replayed, nothing moved), refuses anything that is not an
approved Diamond row by name, and refuses everything by name until what pays for
a correction is authorized (diamond_correction_source_not_authorized). That
answer is Dan's: ca_diamond_correction_source is one row or none, written by a
values migration that quotes him and never by code. Under diamond_house the
house pays a player credit and takes a player debit (a house burn and a player
mint on the register, or a player burn and a house mint), so supply does not
move, and a credit the house cannot cover is refused by name; under
new_issuance a credit is minted to the player and a debit retired from them. A
house row moves against the register under either answer, which is how the
house is funded.

Every leg goes through the Mint's own doors (fn_ca_mint, fn_ca_burn) as the
signed-in staff member, so the balance, the journal and the register move
together, under the mint policy's caps and the issuance freeze, and nothing
else in the door writes money. The legs, one immutable receipt
(ca_diamond_adjustment_receipts, keyed by the adjustment) and the settled
status stand or fall together: a leg the Mint refuses rolls all of it back and
comes back under the Mint's own name, the row still approved.

The register's three doors get platform-staff doors of their own
(fn_ca_diamond_adjustment_propose, \_approve, \_reject). Each admits only
fn_is_platform_admin(), only a Diamond row, and names the signed-in caller as
the proposer, approver or rejecter; nothing the caller sends names anyone else.
The second-person rule stays the register's CHECK, and the approvals setting is
not touched.

The migration pins the five functions it calls, authorizes nothing, opens no
switch, changes no existing function or rule, and ends by proving the doors are
staff-only and never anonymous, the money underneath keeps no client key, the
supply identity is whole and every watched guard is on its baseline. The client
reaches each door through one service, src/services/DiamondAdjustmentService.ts.
