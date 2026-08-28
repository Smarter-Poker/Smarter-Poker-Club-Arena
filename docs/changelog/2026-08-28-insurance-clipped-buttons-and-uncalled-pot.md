# 2026-08-28 — Insurance: unreachable Insure/No buttons, pot priced on uncalled chips, rounded-rate fee drift

Source: Dan's screen recording (hand #3158299, Shark Club, NLH 25/50 — kingfish
9-3 suited vs Ryan Thomas AK suited on 9-Q-2, insurance offered to the leader
on the flop).

## What the recording showed

1. The All-In Insurance dialog rendered with NO visible Insure/No buttons.
   The 25s window (visible 23s → 11s → gone) expired into an auto-decline,
   which is FINAL for the hand. The leader could not buy insurance at all.
2. `Pot: 317.61` in the dialog while the table's own pot showed `POT 62`
   at the river.
3. Fee 75.62 x Rate 3.2 = Insured 241.98 was internally consistent, but the
   server contract would have charged 76.66 for that coverage (exact
   premiumRate 0.3168, displayed rate rounded to 3.2).

The equity math itself was verified EXACT: independent 990-board enumeration
of AK suited vs 93 suited (both with backdoor flush draws) on that flop gives
729 win / 261 loss / 0 tie = 73.6% / 26.4%, matching the dialog to the digit.
Outs 6 (3 aces + 3 kings) and 13.3% (6/45 next-card) also correct.

## Fixes (this PR)

1. **`src/components/table/InsuranceModal.tsx` / `.css`** — the modal is
   `max-height: 90vh; overflow: hidden` with no scroll container; on a phone
   the content above the actions row exceeds 90vh, so the buttons rendered
   below the clip line — unreachable. Everything between the header and the
   actions now lives in `.insurance-modal__body` (`overflow-y: auto`), and
   the action buttons are pinned outside the scroll area, always on screen.
2. **`server/src/engine/HandController.ts`** — `advanceStage()` emitted
   `ALL_IN_RUNOUT` with `state.pot` still holding the UNCALLED portion of the
   final bet (returned only later in completeHand). Insurance therefore priced
   the leader's own returned chips: a ~287 shove over a 31 all-in produced
   "Pot 317.61" against a 62-chip contested pot, max coverage 317.61, and
   "For Winning: 241.99" — an amount the hand could never pay. Fix: call
   `returnUncalledBet()` immediately before emitting `ALL_IN_RUNOUT` (betting
   is definitionally over in that branch). This also corrects `totalInvested`
   → the offer's `atRisk` → the Break Even preset, and the equity-display /
   RIT pot in the same stroke. Idempotent: completeHand / RIT's later calls
   return 0.
3. **`InsuranceModal.tsx` money math** — insured pot and the Constant Profit
   preset now use the exact multiple `1 / premiumRate` instead of the
   1-decimal display rate, so the premium the server derives from the accepted
   coverage equals the fee shown, to the cent. Rate readout now shows 2
   decimals so Fee x Rate visibly equals Insured Pot.

Verified: `tsc --noEmit` clean (client tsconfig.app + server), vitest 45/45
across InsuranceEngine, InsuranceRitExclusivity, HandController.stackdeltas,
HandController.audit, RunItTwice.money, AHandAlwaysHasAWinner; plus the
client unit suites touching table modals (53/53).

## Open product decision (NOT changed here — needs Dan's ruling)

Settlement deducts the premium in BOTH outcomes ("premium deducted like
rake"), but the dialog's "For Losing" shows the insured pot GROSS of the fee,
and both presets assume the fee is only borne when you WIN (reference
semantics). With the current settlement, "Constant Profit" is not constant:
win nets pot − fee, lose nets insured − fee. Two coherent resolutions:

- (a) Keep settlement; display "For Losing: insured − fee" and re-derive the
  presets. Keeps the 20% house margin exactly as priced.
- (b) Full reference parity: waive/refund the premium on a loss, and reprice
  `rate = pWin / (1.2 x pLoss)` so the 20% margin survives. Rates shown to
  players drop (3.16 → 2.32 in this spot).

Pricing, settlement, and ledger must move together; whichever branch is
chosen, change them in one commit.
