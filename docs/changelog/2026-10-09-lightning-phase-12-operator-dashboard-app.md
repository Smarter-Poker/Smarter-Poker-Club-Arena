# Lightning Phase 12: The Operator Dashboard In Club Operations

## What Shipped

A **Lightning** door in the club operations workspace
(`/hub/club-arena/clubs/:club/lightning`, Club Control group, `control` access:
owner, co-owner, admin and platform staff, the same roles the database gate
admits through `fn_ca_can_review_integrity`). The server gate is authoritative;
the registry only decides who is shown the door.

The page is lazy-loaded (`lazyWithRetry` in `App.tsx`), so neither the page nor
its read hooks reach the entry chunk. The latency chart is a second lazy chunk
(Recharts, the app's existing chart library).

### Overview

Every Lightning-capable Cluster of the club, from
`fn_lightning_operator_overview(p_club_id)`:

- mode (Must Move, Lightning, Pending with its direction, Frozen), epoch and
  how long it has been in that mode;
- live eligible players against the ON and OFF thresholds;
- pool health (joining, eligibility check, active, sit out, disconnected,
  leaving), holds pending and committed, instances forming, reserved, dealing
  and settling;
- orphan holds, open blind obligations, a stuck conversion (with its
  direction), the freeze reason, open alerts and open integrity signals;
- the candidate matcher verdict, comparisons and quality delta;
- P50, P95 and P99 per action-latency leg of the latest window;
- the feature flags (Lightning, shadow matcher, integrity scan, auto rebuy).

It refreshes every 15 seconds while the tab is visible and never while it is
hidden.

### Cluster Detail

`fn_lightning_operator_cluster(p_cluster_id, p_from, p_to)` with a window
picker (1 hour, 6 hours, 24 hours, 7 days), refreshed every 30 seconds:

- conversion state and the mode transitions timeline (epochs, conversions,
  the freeze);
- open holds (orphans in red), the open blind ledger;
- the stack reconcile table (anchor stack, exposure, pool stack); a row whose
  `ok` is not true is printed in red with how far it is off;
- the candidate matcher report (live and candidate quality, delta mean, min
  and max, share of windows the candidate won, every component);
- integrity signals, each with a review action through
  `fn_lightning_operator_signal_review` (Reviewed, Cleared or Actioned, with a
  note), the only writing operator door;
- open alerts, titled by the sweep's check (Cluster Frozen, Conversion Stuck,
  Drive Errors, Reaper Failures, Integrity Spike, Latency Regression);
- the latency windows chart per leg and the latest window's table;
- a hand replay check for one hand (`fn_lightning_operator_hand_replay`):
  verdict, defects, hand number and each seat's stack before, after and net;
- a player session trail (`fn_lightning_operator_session_trail`): the
  session's steps and the mode transitions that overlapped it. Tapping Trail
  on a reconcile row fills the session in.

## Laws Kept

- No card is shown anywhere. The doors redact (`fn_lightning_operator_redact`)
  and the client renders no card field; a test pins that the operator sources
  name none.
- Horses are players (Law 10.5): no badge, filter or column distinguishes
  them; every count counts everyone.
- Operator vocabulary only: Lightning, Must Move, Lightning Fold, Fold &
  Watch. No rival product name appears (pinned by test).
- Nothing on the page moves a player or changes a Cluster. Opening a Cluster
  changes this page's own query string.

## Calm Failure

- `{ok:false, code:'NOT_AUTHORIZED'}` (or a 42501) prints a restricted note
  and stops the refresh loop.
- A missing function (`PGRST202` or `42883`, the migration not yet applied)
  prints **Not Available Yet** and stops the loop: no crash, no retry storm. A
  manual Refresh still asks.
- Any other refusal (`NOT_FOUND`, `INVALID_WINDOW`) prints its code; a fault
  keeps the last reading's age visible and polls again.

## Visual Standard

Built on the #ClubArenaConsole chassis: the spade console for the overview,
the riveted console for a Cluster, Back and Refresh on the painted plates,
every table printed as rows on the glass between engraved rules, choices as
lit words. Verified headless at 393px and 1280px; screenshots in
`/Volumes/SmarterArchives/agent-evidence/lightning-p12-operator-dashboard/`.

## Tests

`tests/lightning/lightning-phase-12-operator-dashboard.test.tsx` (21 tests),
with fixtures built key for key from migration 20261009144343
(`tests/lightning/fixtures/lightningOperatorDoors.ts`). The production E2E
operations sweep (`tests/e2e/support/clubOperationRoutes.ts`) gains the
Lightning route.
