# 2026-08-28 — Insurance round 2: true insurable pot, EV cashout, honest countdown, horse timing, reconciliation + observability

Follow-up to `2026-08-28-insurance-clipped-buttons-and-uncalled-pot.md`
(PR #1591, merged). Dan: "fully build all of these and make sure they are
fully wired in and tested."

## 1. Insurable pot = what the leader actually collects

`ServerTableEngineRunout.computeInsurablePot(leaderId, grossPot)`:

- **Side pots** — a short-stacked leader is only priced on the pots their
  chips contest (`computeLivePots()` eligibility). A leader in a 90 main pot
  under a 200 side pot insures 90, not 290.
- **Rake + BBJ** — winners are scaled proportionally at settlement, so the
  offer prices `eligible x (total − rake − bbjFee) / total`
  (`computeRakeAndBBJ()`, same rules as completeHand). "For Winning: pot −
  fee" is now the number that lands in the stack.

Falls back to the gross pot if the controller cannot answer. Both
`createOffers` call sites and the broadcast use it. Pinned by
`InsurablePot.test.ts` (7 cases incl. both fallbacks).

## 2. EV Cashout — fully wired, end to end

The third answer to the offer: lock `insurablePot x potShareEquity x
(1 − 1% fee)` now.

- **Engine** (`InsuranceEngine`): `evCashoutEnabled`/`evCashoutFeePercent`
  config (default on / 1%), `evCashoutAmount` priced on every offer,
  `acceptEvCashout()` locks it, cancels the expiry deadline, resolves the
  runout pause (`allResponded`), emits `INSURANCE_CASHED_OUT`. `settle()`
  emits a `kind: 'ev_cashout'` settlement paying the locked amount
  regardless of the board's outcome.
- **Settlement** (`ServerTableEngineSettlement`): pays the cashout from the
  bank, then REDIRECTS the player's actual pot winnings back to the bank
  (`currentHandCashoutRedirects`, clamped with a critical financial alert on
  shortfall, same pattern as premium clamps). Ledger row: `premium` =
  redirected winnings (bank in), `payout` = locked cashout (bank out),
  `kind = 'ev_cashout'` — `bank_delta = premium − payout` unchanged.
- **HTTP**: `POST /insurance` now accepts `response: 'cashout'`.
- **Client**: `respondToInsurance(tableId, 'cashout')`; TablePage passes
  `onInsuranceEvCashout` through TableModalsLayer, so the modal's EV Cashout
  tab (dead since the DEAD-BUTTON fix) is LIVE, showing the SERVER'S quote
  verbatim. `insurance_cashed_out` broadcast → "Cashout Locked" /
  "<name> Has Cashed Out" toasts, waiting bar drops.
- Horses still auto-decline (house chips; the fee is pure EV loss).

Pinned by `InsuranceEvCashout.test.ts` (6 cases) +
`insuranceModalLayout.test.tsx` (tab renders only with a handler; server
quote verbatim; Cash Out sends it).

## 3. Countdown honesty

The recording's popup opened at 23s of a 25s window — the client counted
down from a seconds figure that was stale on arrival. The offer now carries
`deadlineAt` (epoch ms); the modal derives every tick from it (drift-proof,
reconnect-proof) and TablePage's auto-decline timer uses it too.
`timeoutSeconds` stays as fallback for old clients.

## 4. Horse leader timing (section 10.5 — "TIMING IS PART OF THE TREATMENT")

The ~1s horse auto-decline was a TELL: the table rolled on instantly when a
horse led, and stopped 25s for a human. A horse now "reads the offer" for a
humanlike 5–12s. Pace cost bounded: a decline is final per hand, so at most
one pause per leader (plus one on a leader handoff).

## 5. Reconciliation + observability (Supabase, APPLIED to production)

- `20260828120000_insurance_kind_offer_events.sql` —
  `insurance_transactions.kind` ('insurance' | 'ev_cashout');
  `record_insurance_transaction` gains `p_kind DEFAULT 'insurance'` (old
  9-arg overload DROPPED first — one overload, no PostgREST ambiguity; old
  servers keep working); `insurance_offer_events` funnel table (offered /
  accepted / declined / timeout / cashed_out / settled), RLS on with no
  policies (service-role only).
- `20260828120500_insurance_reconciliation_and_views.sql` —
  `reconcile_ledger_nightly` gains an `insurance_bank` section: ledger sum
  (premium − payout) per bank entity vs the stored
  `union_wallets.insurance_wallet` / `club_wallets.insurance_balance`;
  views `v_insurance_pnl` (money per club/union/kind/day) and
  `v_insurance_activity` (the decision funnel + avg offer equity/pot), both
  `security_invoker`.
- `20260828121000_insurance_bank_entity_type_in_reconcile_check.sql` —
  the `ledger_reconcile_log` entity_type CHECK didn't allow
  'insurance_bank'; found by RUNNING the function right after applying, not
  by a player. Extended.

Verified live: `reconcile_ledger_nightly()` now emits
`insurance_bank | ok | −307.49 = −307.49`; the new RPC probed in a ROLLED
BACK transaction both with `p_kind='ev_cashout'` and with the old 9-arg
call shape (rule 11.5 — no committed side effects).

The engine writes the funnel via `services/supabase/insuranceOfferLog.ts` —
fire-and-forget, never throws, never blocks gameplay. Timeout declines are
distinguished from button declines (`decline(..., source)`).

## 6. UI polish

Sticky bottom gradient on the scrollable modal body ("there's more below"),
pointer-events none. Layout contract pinned:
`insuranceModalLayout.test.tsx` asserts the action buttons are SIBLINGS of
the scroll body — a short viewport can never hide them again.

## Verified

Server `tsc --noEmit` clean; client tsc clean in touched files (pre-existing
unrelated TablePage errors from concurrent agent work remain). Vitest:
92/92 across the 13 server insurance/hand/RIT suites (incl. the two new
files), 60/60 client unit incl. the new modal suite.
`insuranceLedger.test.ts` updated in the same commit for `p_kind`.

## Pre-existing findings surfaced while verifying (NOT touched here)

`reconcile_ledger_nightly()` run today reports 3 pre-existing criticals
unrelated to insurance: two `club_treasury` drifts (ledger 65,794.52 vs
stored 12,459.07; ledger −40,296.63 vs stored 0.00) and one
`negative_balance` (−4,566.10). Someone should chase those.
