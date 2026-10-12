# Add-On Popup Verification Repairs

## Scope

Preserve the approved October 9 Smarter.Poker add-on chassis and the single fee-inclusive Add-On Cost row. Repair defects reproduced while verifying this popup. No engine, monetary service, database, wallet, purchase or public deployment mutation is part of this patch.

## Repairs

- Correct singular chip labels in cost, wallet, award, insufficient-balance and accepted-receipt copy. The duplicate Total Charged row stays absent.
- Capture a stable absolute fallback deadline when a presentation opens or receives a changed relative deadline. An unrelated wallet render cannot extend it. The persisted server deadline remains authoritative. Clicks also check elapsed wall time, not only the last timer repaint.
- Make confirmed and unknown-result receipts dismissible through Close, the cross and Escape. Synchronous one-shot dismissal prevents duplicate callbacks, later timer re-declines and purchase attempts after dismissal. Pending purchases remain protected. Dismissing an unknown receipt does not change its durable financial outcome.
- Refuse new purchase submission for unusable non-finite price, fee, wallet or chip-award inputs. Display Unavailable and an explanatory alert rather than misleading zero, NaN or Infinity values. Existing unknown-result confirmation retries retain their original handling.

## Regression Evidence

Baseline 3bfc46f8771a1cd9e6cdd523703387b55ed03b96: the 22 existing price/receipt tests passed; 17 of the 19 new verification cases failed before the source repair.

After the repair: all 75 focused tests passed, all 113 selected contracts passed, and all 593 import-related tests passed. These runs overlap and are not a claim of 781 unique tests. The local TypeScript compiler, four copy gates and policy integrity check also passed.

The real-component Chromium fixture passed 19 browser checks and captured 20 screenshots at 320, 375, 393 and 1280 pixels wide, including long values, pending, accepted, unknown, not-submitted, insufficient and invalid-data states. It checked native artwork geometry, overflow, actual Inter and Roboto Condensed fonts, keyboard focus, Escape, expiry and the automated WCAG A/AA dialog audit. All purchase callbacks were local fixtures and external account traffic was blocked. Browser results are isolated component proof, not production transaction proof.

## Delivery Boundary

The protected merge, owning Hetzner publication and public build-identity readback are separate delivery requirements. This changelog does not claim that an unpushed candidate is live, that an actual purchase was made, or that the entire platform is defect-free.
