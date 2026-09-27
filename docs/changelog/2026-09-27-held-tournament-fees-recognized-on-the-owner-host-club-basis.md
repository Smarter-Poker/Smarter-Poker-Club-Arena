# Held Tournament Fees Are Recognized On The Owner Host Club Basis (2026-09-27)

## What Was Wrong

Eighteen completed tournaments held 741.86 chips of entry fee in `tournament_escrow`
with `accounting_state = 'fee_custody_unresolved'`. Every player was final and
paid; only the house fee was held. The capture authority prices each fee
contributor through `fn_accounting_earning_contract` at the charge instant, and
every one of those charges predates the recorded agreement history (club
membership baseline 2026-09-14 12:09:27Z, union baseline 2026-09-18 00:41:16Z).
The contract refused with `accounting_terms_not_observed` or
`cash_commission_earning_club_not_observed`, so the fee could never leave custody.

Read from production before the change: every one of the uncaptured contributors
resolves through the same contract at the event's completion instant.

Two connected defects blocked the same events:

- `fn_ca_legacy_fee_resolution_write_is_exact` admitted the union rake-bank
  journal leg only for the five Sept-8 Spins, and only club-less. Since
  20260921065613 the tournament rake payer names the event's club on that leg,
  so no union-hosted held fee could resolve.
- The five Sept-8 Spin standings witnesses compared the accepted hand's live
  `hand_history` and `hand_atomic_commits` rows with the retained snapshot. The
  owner's eight-day horse hand-history retention (2026-09-17) has since removed
  those horse rows, so every terminal receipt for those events raised
  `SPIN_ORIGINAL_STANDINGS_CHANGED`.

## The Owner Decision

Dan, 2026-09-27: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF THESE" and the
standing "i don't have options or decisions, you always decide what's best and
what to do" (CLAUDE.md 10.9). A tournament entry fee is the house fee of the
club that hosted the event. It flows onward exactly as that club's cash rake
does, through the union/club agreement and agent hierarchy recorded at the
event's completion. No code-default rate is used as if it were an agreement.

## What Changed

Migration `20260927155651_held_tournament_fees_are_recognized_on_the_owner_host_club_b.sql`:

1. Append-only `accounting_tournament_fee_owner_operations` and
   `accounting_tournament_fee_owner_bases` record the single-use operation and
   each event's basis: hosting club, union, completion instant, amount, reason,
   owner instruction, authorization date and operation id.
2. `fn_ca_capture_tournament_fee_from_recorded_evidence` keeps every evidence
   check. Only when the charge-time contract refuses because terms were never
   observed, and this same transaction recorded an owner basis for the event,
   is the contributor priced by the same contract at completion. The contract
   names the basis (`contract.owner_basis`). Missing terms at completion still
   refuse, and the event stays held.
3. `fn_accounting_tournament_source_terms_at` is the one agreement-instant rule
   for a tournament source: its charge instant, or the recorded owner-basis
   completion when the contract names that exact basis. The weekly quality
   gate, the union earned plan and the rakeback period calculator use it where
   they required `terms_at = charged_at`. It inlines as a keyed CASE; with no
   owner basis every reader computes exactly what it computed before.
4. The resolution write guard admits an owner-basis event's union rake-bank leg
   exactly as it admits a Sept-8 Spin's, and accepts that leg naming the
   event's own club.
5. A Spin hand counts as retired, not changed, only when both rows are absent,
   the snapshot is that exact hand, it had no human, and it is older than the
   recorded horse retention.
6. `fn_ca_recognize_held_tournament_fees_by_owner_basis(operation, events)`
   takes the settlement lane, requires the exact listed held events and
   amounts, records each basis, settles each fee through the existing
   `fn_settle_tournament_rake` custody resolution, bank and
   `fn_recognize_accounting_tournament_fees` path, and proves escrow out = bank
   in = recognized credit, prizes and the player terminal untouched and the
   `settlement_suspense` journal unchanged. A replay returns its record.

## Qualification

`scripts/dev/test-full-weekly-accounting-activation.sh` gains two phases, both in
the default required run:

- `held-fee-owner-basis`: over the retained Early Bird event (27 original fee
  rows, 2.70), the owner path is first brought to the 30 captured production
  bodies. Synthetic agreements exist at completion only. The installed
  predecessor refuses; the candidate installs; the operation resolves the fee
  once and the weekly quality gate, union earned plan and rakeback joins verify
  it. 33 assertions, including refusals, replays and append-only records.
- `held-fee-spin-retention`: after the complete Sept-8 Spin phase, the
  predecessor refuses all five terminal receipts once retention retires the
  horse hand; the candidate returns the identical receipt, while a changed,
  half-retired or in-window missing hand still refuses. 52 assertions.

## Operation

Installed separately from the run. The run is one call with a fixed operation
id after 2026-09-28 10:30Z, so the fees are recognized in the week that starts
2026-09-28 and are picked up by that week's normal accounting.
