# A resolved refusal is not an open refusal

Board incident: `hand-commit-refusals-sweep-restates-healed-refusals` (issue
#5070, Production Alerts Fleet).

## What was wrong

`fn_ca_hand_commit_refusals` (behind the `fn_ca_conservation_sweep:fn_ca_hand_commit_refusals`
drift source) counts `public.financial_alerts` rows where
`source = 'ServerTableEngine.authoritative_hand_semantic_refusal'` inside a
rolling window, but never checked whether the individual row was `resolved`.

Measured 2026-09-27 16:05 UTC: 6,657 of 6,663 rows of this source were already
`resolved` (0 rows where the `resolved` boolean disagreed with `resolved_at`),
most with a resolution proving no chips moved
(`fn_unaccounted_seat_exits()` returns 0 rows for the class). The 2026-09-10
fix (`a_detector_does_not_report_what_it_already_answered_for`) added a
watermark so the detector's window starts at the later of its rolling span
and the last time _this detector's own incident_ was resolved with a
`correction_ref` - but a `financial_alerts` row can be individually
investigated and resolved between sweeps without that incident-level
correction_ref ever being written. The watermark never moves, so the same
healed refusal counts again on every hourly run until it ages out of the 24h
window by elapsed time alone.

Concretely: `ca_drift_incidents` 07d0babb restated exactly the 68 refusals of
2026-09-26 15:06-15:07 UTC as a fresh `ledger_imbalance` finding, every one of
them already resolved. Earlier incidents ecd5e145 and 5e966c57 show the same
pattern.

## The fix

`fn_ca_hand_commit_refusals`'s `win` CTE now also requires `a.resolved =
false`. Migration `20260927160903_a_resolved_refusal_is_not_an_open_refusal`
substitutes the function body (asserting the anchor text appears exactly
once), re-asserts that the floor of 25, the rolling window, and the
2026-09-10 watermark clause are all still present, and asserts the detector
returns zero findings immediately after the change - proving nothing
genuinely open was silenced along with the noise.

This does not touch any `financial_alerts`, `ca_drift_incidents`, or
`operational_alert_events` row - it only changes what the detector counts on
its next run. The 91 duplicate receipts already recorded in
`operational_alert_events` for this class are a separate, already-scoped item
(the lease-proof-expired H1b plan on the board) and are not touched here.

## Hardening

- Regression: `tests/a-resolved-refusal-is-not-an-open-refusal.law.test.ts`
  (fails until the migration exists and carries the filter; passes after).
- Law registered: `docs/laws.d/a-resolved-refusal-is-not-an-open-refusal.md`.
- Detection: the sweep itself (`ca-conservation-sweep-hourly`) is the
  detection route; it now only re-raises on genuinely unresolved refusals.
- CI: covered by the existing `tests/` run in `publish-club-arena.yml` and
  `ci.yml` (no new gate needed - this is a plain migration-corpus law test).
