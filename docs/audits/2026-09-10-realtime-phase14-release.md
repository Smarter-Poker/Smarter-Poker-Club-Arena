# Phase 14: Lobby Inventory And Waitlist Recovery

Source PR [#4095](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4095) merged through the normal autopilot at **2026-09-10 04:04:09 UTC**, as `c41635319207842a45b9dc65d87ba9f00da130ed`. The tested source head was `7e2ebc05bc52d28e26e257e01c8df663cfa3a75e`. Public and origin publication are verified. Natural reconnect and physical iPad/PWA acceptance remain open.

## Repaired Behavior

- The club lobby has one occupancy request owner, released in `finally`, so a slow request cannot accumulate overlapping occupancy reads.
- Inventory reconciliation decides whether to reload outside the React state updater. Omission handling is scoped and bounded; the projection retains the scope fields needed for that decision.
- The table drawer refreshes its waitlist after a settled join or leave and ignores retired reads. A refused optimistic mutation preserves the verified queue. Both null and thrown read failures invalidate the completed-read marker.

The downloaded, actually referenced production page chunk was inspected for the single occupancy owner and `finally`, the reconciliation decision outside the updater, scope fields, and both waitlist invalidation paths. This verifies the compiled repair is present; it does not establish live device behavior.

## Reproduction And Validation

| Check                               | Evidence                                                                                                                                                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory regressions before repair | 3 failed, 11 passed                                                                                                                                                                                         |
| Drawer regressions before repair    | 4 failed, 1 passed                                                                                                                                                                                          |
| Focused validation after repair     | 96 passed across 8 files                                                                                                                                                                                    |
| Normal push gates                   | 206 tests across 17 files, followed by 902 tests across 59 files; these overlap and must not be added                                                                                                       |
| Local build                         | Stopped by `ENOSPC`; production compilation was subsequently verified in CI and the publisher                                                                                                               |
| CI run `34434704916`                | Required TypeScript, production build, route performance budget, all four client shards and aggregate, CSS Beat E2E, Table Studio purchase/sync/accessibility, and Insurance/Rabbit Hunt 375px gates passed |
| CI exclusions                       | Live Production E2E and Post-Deploy Verification were skipped; they are not production UI acceptance evidence                                                                                               |
| Autopilot run `34434704961`         | Enable squash auto-merge succeeded; GitHub PR metadata confirms the actual merge                                                                                                                            |

## Actual Publication

[Publisher run `34435729782`](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34435729782) completed successfully; its run metadata was last updated at **04:07:37 UTC**. Build Club Arena, provenance stamping, dist completeness, all four publisher client shards, and the actual origin publication steps passed. Capgo OTA was skipped.

The `publish-to-origin` job (`102740809309`) records:

- **04:07:30.447 UTC:** current release resolved to `/srv/club-arena/releases/c41635319207842a45b9dc65d87ba9f00da130ed` after the rsync and symlink swap.
- **04:07:31.742 UTC:** the origin verification reported `origin serves c416353`.
- **04:07:32.284 UTC:** publication converged on the then-current main commit.

Fresh cache-busted reads at **2026-09-10 04:10:55.384929 UTC** found both the [public stamp](https://smarter.poker/hub/club-arena/build-info.json) and [origin stamp](https://ca-static.smarter.poker/build-info.json) serving exact merge `c41635319207842a45b9dc65d87ba9f00da130ed`, built at `2026-09-10T04:06:36Z` by run `34435729782`.

| Actually Referenced Asset     | SHA256                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `index-LJBeiXa3-v6.js`        | `1afef37ca6a025dc2b6f1f8e947a8f9e39daec83d1379e4a30f327d4ee6375d6` |
| `ClubHomePage-C3UbTFs2-v6.js` | `a30f1fe8bdffae1ee008f697905ef045662ae613c905cdb13c70ad85be21d6e9` |

The public and origin page chunk bytes are identical. Tested and merged runtime source blobs also match:

| Runtime File                              | Identical Blob                             |
| ----------------------------------------- | ------------------------------------------ |
| `src/pages/ClubHomePage.tsx`              | `e48e1a73236e8f527831eac5bb9d7b5ca2c212ee` |
| `src/components/lobby/GameLobbyPanel.tsx` | `7ec4fa662caba2cf76c894f467cd5863f7ee2112` |

## Remaining Evidence And Coordination

The Phase 13 acceptance recheck earlier in this run returned `CDP operation refresh tabs timed out after 20000ms` on the initial check and one bounded recovery attempt. No Phase 14 postpublication browser session was verified. Postrelease DOM acceptance, natural reconnect, and physical iPad/PWA acceptance remain open.

Mac access recovered. The prescribed `scripts/ci/pr-status.mjs` status read at **2026-09-10 04:35:13.333 UTC** confirmed PR4095 closed and merged at exact `c41635319207842a45b9dc65d87ba9f00da130ed`. Its `RED_NON_BLOCKING` classification refers only to canceled duplicate opener `34434624113`, marked `required: false`; successful opener `34434624167` exists. Source CI, publisher, and watchdog `34435949753` succeeded. The earlier Mac timeout is not an active blocker.

The separate [Post-Deploy E2E run `34435949773`](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34435949773), triggered for merge `c41635319207842a45b9dc65d87ba9f00da130ed`, was still in progress at **04:37:22 UTC**. Production readiness, spec alignment, account setup, and the live cashier database-contract steps succeeded. The authenticated production Cashier step failed; the broader deployed-page suite was still running, with honesty, cleanup, and report steps pending. A read of the active job's logs returned `404 BlobNotFound`, so no specific failing assertion or Phase 14 cause is established. The workflow includes Chromium club-lobby and WebKit live-table realtime checks with retries disabled; configured coverage is not a passed result. This unfinished production run does not close the browser, reconnect, or device acceptance gaps.

There were no engine, container, tag, host-checkout, or Stage-B DDL mutations in this phase. No new cron, bypassed hooks, manual PR opening/merging, forced workflow retries, or live balance/seat probes were used. The separate release coordinator retains engine and Stage-B ownership.

This snapshot records Phase 14 publication separately from its unresolved production UI and device acceptance.
