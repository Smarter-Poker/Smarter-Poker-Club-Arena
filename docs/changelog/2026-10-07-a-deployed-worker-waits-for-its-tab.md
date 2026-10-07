# A deployed service worker waits for its tab (2026-10-07)

## What failed

Post-Deploy E2E run 37620236888, lane `Live-table and engine verification`,
failed in global setup at 12:29:07Z:
`Club a41434bb-... did not commit after 2 attempts` (`page.goto: Timeout 60000ms`).

"Did not commit" is `tests/e2e/support/ensureClubMembership.ts`: `page.goto`
with `waitUntil: 'commit'`, two attempts of 60s. The navigation never received
a response. The setup observation shows why it is not a slow database write or
a slow origin: from the start of the membership stage (19.5s) no request left
the tab at all for 60s; at 79.5s the first navigation surfaced only to be
aborted by the second attempt, which then sent nothing for another 60s.

Timing: the publisher swapped the origin to `68b28e5b` between 12:26:57Z and
12:27:05Z. The setup page reloaded at 12:27:06.4Z (the Terms persistence
reload), booted the new release, and the first club navigation at 12:27:07.7Z
hung. The only other occurrence in the last sixty runs, run 37579424861
(06:10Z), has the same shape: publish of `32baeb2c` finished its swap at
06:10:36Z, the setup reload followed, the first club navigation timed out at
60s and the retry joined. The origin itself never stalled: a 2s probe of both
hosts across a later swap stayed at about 0.2s. Not a freeze-window overlap
(12:27 and 06:10 are outside :50-:03).

## Cause

Reproduced on two local builds with `tests/stale-client` (deploy A, sign in,
open notifications, deploy B, reload, navigate): about half of attempts hung
exactly as in CI, the page target already naming the destination URL, the
renderer idle and answering nothing. Varying one thing at a time:

| variant                                       | hangs        |
| --------------------------------------------- | ------------ |
| builds as shipped                             | about 1 in 2 |
| B with A's `sw-bus.js` (no worker update)     | 0 of 6       |
| B's worker without `clients.claim()`          | still hangs  |
| app's `controllerchange` listener suppressed  | still hangs  |
| B's worker without `skipWaiting()` at install | 0 of 8       |

The new worker's `skipWaiting()` at the end of install activated it about
400ms after the page booted, whatever the page was doing; landing during the
tab's navigation away, the navigation never committed. A player whose tab
boots right after a deploy and navigates at that moment hits the same wall.

## Fix

- `public/sw-bus.js`: install no longer calls `skipWaiting()`. A new worker
  activates on its own only when no tab is open. A `SKIP_WAITING` message is
  the one way an open tab hands over.
- `src/hooks/useShellUpdateGate.ts`: the gate, which already decides when a
  tab may reload onto a new release, now hands over first
  (`handOverToWaitingWorker`: post `SKIP_WAITING`, wait for this tab's
  `controllerchange`, bounded at 3s) and then reloads, so activation never
  overlaps a navigation the page did not start. Until a hand-over, the old
  worker's freshness race still serves the new shell from the network.
- `tests/unit/aDeployedWorkerWaitsForItsTab.test.ts` pins both halves.

No retry, no skip, and the setup's timeouts are unchanged.
