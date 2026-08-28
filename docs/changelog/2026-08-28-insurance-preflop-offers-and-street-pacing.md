# 2026-08-28 — Insurance round 4: preflop offers, street-reveal pacing, funnel integrity, E2E beat

Dan: "IT ONLY OFFERS AFTER THE FLOP, THIS SHOULD BE OFFERED PRE FLOP, AND
REOFFERED ON THE FLOP. ALSO IT MUST ACTUALLY SHOW THE FLOP FIRST, WAIT 1
SECONDS AFTER FLOP BEFORE THE OFFER POPS UP. USERS NEED TO SEE THE FLOPS,
TURNS AND RIVERS."

## 1. Preflop offers (`ServerTableEngineRunout`, `InsuranceEngine`)

A preflop all-in used to deal the flop first and only offer there. The flow
now offers on the EMPTY board:

- Preflop there is no made hand to rank, so the leader is the exact EQUITY
  favorite (`insuranceEquity`'s seeded 6,000-board sample — the same number
  the pricing uses). A dead-even matchup (±0.05%) offers to nobody,
  mirroring the tied-hands rule.
- The dialog labels the street "Preflop All-In" instead of a meaningless
  "Outs: 0" (no outs exist before a flop).
- **Decline finality follows the street** (`offer.boardLength`): a PREFLOP
  decline or timeout is STREET-ONLY — the same leader is re-offered on the
  flop ("reoffered on the flop"), where the 2026-08-26 rule takes over
  unchanged: flop/turn declines and timeouts stay FINAL for the hand.
  Accepting preflop locks coverage for the whole runout — no re-offer.
- Horses inherit all of it identically (section 10.5): a horse leader takes
  its humanlike 5–12s pause preflop AND on the flop re-offer.

## 2. Street-reveal pause (`dealNextInsuranceStreet`)

After a street lands in the broadcast, the flow now holds a full 1000ms
before the next offer pops — every seat SEES the flop/turn before a dialog
covers the table. (The pre-deal `allInStreetPauseMs` beat is unchanged; this
is a new post-deal beat.)

## 3. Multi-table countdown honesty (`TablePage`)

`setDecisionDeadline` for insurance now anchors to the engine's `deadlineAt`
instead of `Date.now() + seconds`, so background-tab countdowns match the
popup exactly.

## 4. Funnel integrity (Supabase — APPLIED to production)

`20260828190000_insurance_offer_unresolved_check.sql`:
`fn_unresolved_insurance_offers(interval)` — per (table, hand, player) over
the window, offered-count must not exceed resolved-count once the newest
offer is >3 min old. `reconcile_ledger_nightly` files each violation as a
CRITICAL `insurance_offer_unresolved` row (CHECK allowlist extended).
Verified live: function applied, nightly runs clean (0 unresolved offers in
today's real traffic).

## 5. Insurance beat in the CSS Beat E2E suite

`tests/e2e/live-animations.spec.ts` gains "the insurance dialog, on a short
phone viewport": real Chrome, this commit's real CSS, 375×480 viewport,
full-content modal — asserts the body scrolls (`overflow-y: auto`, actually
overflowing), BOTH decision buttons are painted inside the viewport and
hittable (`elementFromPoint`), and the scroll-affordance fade rides the body
(`position: sticky`). This is the recording's exact defect, pinned at the
pixel level. (Could not be executed in the sandbox — no browser; CI's
required CSS Beat E2E check runs it.)

## Verified

Server tsc clean; vitest 39/39 (InsurancePreflop new, InsuranceEngine,
InsuranceEvCashout, InsuranceRitExclusivity, InsuranceLeaderHandoff);
client 9/9 modal suite (2 new preflop cases). Migrations applied via
Supabase MCP and mirrored in `supabase/migrations/`.
