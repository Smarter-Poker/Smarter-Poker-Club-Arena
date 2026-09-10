# Phase 16 Release Evidence

## Repair And Validation

[PR #4125](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4125)
merged as `1dac6fe01fcb9eea5aabdc26afc3e32ef4deb3e8` at
2026-09-10 06:17:02 UTC. The Cashier tile and shortcut 4 now distinguish a
pending directory read from confirmed empty memberships. The existing loader
owns readiness, preserving cached destinations, failure recovery and account
isolation without adding a cron, timer, subscription or database change.

The mounted baseline reproduced five failures with three preservation cases
passing. All eight mounted cases passed after repair. The focused total was
49 tests across four files, including those eight. TypeScript and the integrated
build passed. Normal push counts overlap and must not be added together.
Source CI run 34443914612 and autopilot run 34443914674 passed; source CI's
live jobs were skipped.

## Publication Proof

The original publisher, run 34444526280, served the exact merge from the origin
at 2026-09-10T06:20:32.6619200Z, verified in job 102766905779.

Fresh cache-busted reads at **2026-09-10T07:02:36.532428Z** found the same release
on [public build-info](https://smarter.poker/hub/club-arena/build-info.json) and
[origin build-info](https://ca-static.smarter.poker/build-info.json):
`c50dc3abd9f6195577d7fd1ea07a442559632256`, built at 06:56:27 UTC by
run 34447315196. Git ancestry proved that release contains the Phase 16 merge.
Its source and mounted-test blobs exactly matched tested head
`0635c7261a2aa0d71ad6dbedb345a1ebd17d5c60`.

| Verified Asset                                                          | SHA-256                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Referenced Public `index-nKuGglWA-v6.js`                                | `98a5be8fbda1afbe1bef1c19b29eade368b020db6667593f5890ce85b39a3322` |
| Referenced `HomePage-DNbi6FCq-v6.js`, Identical Public And Origin Bytes | `6373768d049c90e8e1d2117a3eeed05ae6a0d8af368d95b7fbe9f051a1e92bd5` |

Both compiled pending-first Cashier branches were inspected in that referenced
HomePage asset. This closes the earlier public-byte verification gap. Exact
commits, source/test blobs and timestamps are retained in the companion JSON.

## Acceptance Still Open

Earlier Phase 15 E2E run 34440738779 tested
`56962e048d024cb3215a255529c7b1491873db72`, **before Phase 16**.
It executed 292 tests across 34 files, with nine failures, two skips and zero
flaky results. Cashier passed two checks; Club Lobby passed six with two skips.
Cleanup was verified at 2026-09-10T06:15:07.2920327Z.

The nine failures comprise three stalled-fleet prerequisites, one missing cash
fixture, three profile-gate preflight timeouts, one mobile tap-target failure
and one stale hamburger-branding expectation. These require separate
disposition and are not closed by this publication proof.

Live acceptance of the repaired pending-directory behavior, natural reconnect
and physical iPad/PWA behavior remains incomplete. The supported controlled
browser has not provided usable acceptance access. Neither Phase 15 nor
Phase 16 is certified 100% complete.
