# Retained MTT original-hand disposition

Two retained managers cannot use the generic interrupted-hand operation because they still own mixed table moves. One original has a persisted interrupted preflop snapshot; the other has a sealed prior accepted hand plus two completed inbound moves, and an accepted zero-stack elimination still owned by its original settlement path.

`fn_f06_abort_retained_mtt_hands(receipt_id, expected)` is a separate, service-only zero-credit owner. It accepts one exact unresolved original MTT permit and compares the full locked canonical event, lease, seat/registration, movement/member/attempt/winner and dispatch vectors. The original generic abort remains unchanged. The existing immutable mixed-abort receipt, hand fence and generation fence record `aborted_unsettled`; they never record `never_started` or an invented hand result.

The two supported proofs are:

- `original_preflop_snapshot`: original incomplete preflop snapshot, empty action history, exact original player/chair and saved stack plus investment, conserved pot, retained card-row identities/hashes. Individual antes already included in investment are not credited again.
- `prior_commit_plus_inbound_moves`: sealed last accepted hand for its exact participants, partitioned from the remaining live occupancies by original canonical winning move receipts. Source member occupancy/lifecycle, destination identity, chair, joined time and chips must match. An inbound move may precede the prior hand's commit when that arriving player was not a participant in that hand.

An unseated playing registration with zero chips must have its own sealed accepted zero-stack result and exact vacated occupancy. The disposition preserves that registration and financial result. Only the existing accepted-elimination owner may assign its rank or payout.

The lease is acquired `FOR UPDATE` before the event lane to drain protocol-2 admitted writers; later advisory lanes are nonblocking to prevent lock inversion. Sorted player lanes and rows follow the established F06 order. Unknown dispatch/submission, later accepted state, changed evidence, an unexplained zero registration, frozen platform, browser actor or fresh/replaced lease all refuse. Exact replay returns the original receipt; changed replay refuses.

The operation writes only immutable interruption evidence, original generation/hand fences, the original permit's terminal state and, where present, the exact original incomplete snapshot's completion marker. It does not update the old lease, tables, seats, chips, registrations, movement state, members, attempts, winner receipts, ranks or payments.

## Physical and deployment boundary

SQL binds a caller-supplied physical evidence record to the exact lease/source/process/manager/engine/permit. It cannot inspect another process or prove retirement from lease expiry or missing storage. The owning recovery/release operation must separately qualify the complete actual process population and exact original stopped-owner work before disposition. This migration installs no watcher and does not actuate anything.

Disposition must precede restart-surviving mixed custody preparation while the original expired lease still exists. Custody transfer must bind the immutable original hand receipt and all pending movement identities. The old runtime's unresolved local preparation remains a deployment prerequisite; SQL success does not open the maintenance gate or authorize a restart. Healthy-table parking, freeze and full cutover/rollback reserve remain required.

## Verification

The existing required F06 PostgreSQL accounting runner executes both native fixtures, unchanged generic-owner refusals, zero-credit preservation, changed evidence/permission/freeze refusals, real concurrent admission/settlement/mixed-writer locks, replay and permanent hand/generation fencing. Source composition is checked against the reserved migration. This is database contract qualification; physical process retirement, installation, custody admission and production recovery require their own evidence.
