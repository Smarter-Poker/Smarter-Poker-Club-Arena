# Daily Missions Phase 8: One-Diamond Rerolls And Precision Casino Hardware

## Scope

This corrective phase follows the full Daily Missions production certification.
It reprices every fresh Daily Challenge reroll to one Diamond, repairs clipped
frame seams across the complete challenge surface, and turns each mission icon
into a live instrument that responds to mission type, progress, completion,
claim state, keyboard focus, and reduced-motion preferences.

## Economy Contract

- The browser displays, confirms, validates, records, and reports a one-Diamond
  reroll through one shared constant.
- Both authenticated reroll RPC signatures now default fresh requests to one
  Diamond and reject callers attempting to choose the retired price.
- An idempotent retry spends zero additional Diamonds.
- Every successful reroll reconciles the current revision-bearing dashboard
  before painting it. Receipt retries return an acknowledgment only, so neither
  a delayed fresh response nor an older replay can regress a newer mission or
  wallet balance from another tab.
- Historical ten-Diamond receipts remain replayable without another debit, so
  correcting the price does not break already-settled requests.
- The compatibility RPC accepts a changed assignment as a replay only when an
  exact price-bound receipt or Diamond journal entry proves settlement.
- UUID-less compatibility retries also check proof before trusting assignment
  equality, preventing a second debit if a catalog ID cycles back to its prior value.
- Global wallet surfaces perform a forced authoritative balance refresh after
  the dashboard reconciles, even when the profile realtime frame is unavailable.
- Concurrent rerolls on different cards remain serialized against the player
  wallet and settle exactly two Diamonds in total.

## Casino Realism And Frame Repair

- Continuous layered rails now close every chamfered mission card, hero,
  loading panel, empty state, reward dialog, freeze dialog, and clipped action
  control without depending on fragile border fragments.
- Mission icons now include a progress circuit, faceted face, scanner, pulse,
  and type-specific timing. Active, completed, and claimed states each have
  distinct lighting and motion behavior.
- Inline Diamonds, reward gems, and alert hardware receive restrained live
  feedback consistent with the Club Arena footer instrumentation.
- Mobile hero geometry was recertified after repairing a cascade that could
  stretch the live-status seal over the heading.
- Reward and freeze dialogs keep their precision frame fixed while only the
  inner content scrolls. Initial keyboard focus now lands on the dialog title,
  including at 390 by 320 pixels, without skipping the purchase context.
- Reduced-motion users retain the state and lighting information without
  continuous animation.

## Additional Defect Closed

The final production journey exposed an alert-status priority bug. When a saved
alert preference was on but the current browser was disconnected, a denied
browser permission could hide that saved state. The panel now leads with
`Preference On, Device Disconnected` and keeps the browser-settings explanation
as supporting recovery guidance.

## Verification Contract

- Static economy tests reject every fresh ten-Diamond path and certify the
  migration, grants, defaults, constraint, receipt ordering, and client reconciliation.
- Production-backed browser coverage proves fresh debit, exact replay,
  historical replay, retired-price rejection, cross-tab serialization, claims,
  alerts, injected outage recovery, responsive layout, accessibility, and
  zero-residue fixture cleanup.
- Geometry checks require closed frame rails on every rendered mission card and
  control, no horizontal overflow, an unclipped mobile title, and movement from
  every dynamic mission icon while motion is allowed.
- The production database migration is byte-identical to its recorded ledger
  entry and its installed functions, grants, defaults, and constraints are read
  back after application.
