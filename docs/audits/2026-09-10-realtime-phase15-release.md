# Phase 15: Confirmed Tournament Inventory

PR [4104](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/4104)
merged through the normal workflow at **2026-09-10 05:18:35 UTC**, as
dc2f45705344564fb9574bb55378cd19680681b6. The pushed head was
be15312bc12b4a16642e8eb2bdd163235a16ce1c.

## Repair And Validation

Confirmed empty tournament reads can remove stale cards. Failed reads, null
responses and unresolved or cache-only scope preserve the last visible list.
A newer joinable realtime row retains the cards and requests one follow-up
through the existing coalesced owner. No cron, timer, feed or DDL was added.

Seven baseline failures reproduced the defect, with 19 other cases passing.
After repair, all 26 mounted cases passed, preserving the 14 earlier cases;
15 scope contracts and 24 anti-flicker contracts also passed. Fixture setup
failures were excluded from the reproduction count. Normal push gates passed
the 26 changed tests and 836 related tests across 53 files; these counts overlap.
TypeScript and production compilation passed. The precommit build's warning
about newer engine-only main work was resolved by integrating that work.

CI 34439338703 passed type checking, structural/stub guards, four client shards,
production build and route budget, CSS beats, Table Studio purchase/sync/
accessibility, and the Insurance/Rabbit Hunt mobile gate. Its live-production
checks were skipped and do not establish live acceptance.

The prescribed status reader at 05:18:45.356 UTC confirmed the actual merge.
RED_NON_BLOCKING referred only to canceled duplicate opener 34439232940,
required=false; opener 34439233090 and autopilot 34439338663 succeeded.

The tested, merged and subsequent main 56962e048d024cb3215a255529c7b1491873db72
files have identical blobs:

| File                                          | Blob                                     |
| --------------------------------------------- | ---------------------------------------- |
| src/pages/ClubHomePage.tsx                    | 00d0dfb7fd1c4701dfc0e6b343c6e48fe276a567 |
| tests/unit/clubHomeRecoveryOwnership.test.tsx | e5eed967c889c97402faff51cfab555399de614f |

## Actual Publication

The publisher advanced to descendant main 56962e048d024cb3215a255529c7b1491873db72.
Run [34440733509](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34440733509)
passed its actual build, four client shards and origin publication. Job
102755735732 recorded the release symlink at 05:25:49.745 UTC, verified the
origin served 56962e0 at 05:25:51.249 UTC and confirmed convergence at
05:25:51.719 UTC.

Fresh cache-busted public and origin reads at **05:26:52.516 UTC** both served
that exact SHA, built at 05:23:47 UTC by run 34440733509.

| Actually Referenced Asset   | SHA256                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| index-Dgr2XHij-v6.js        | 46742352945074e34d3fcba0cf15ec004d7f379260f0c48294237632afa544c4 |
| ClubHomePage-3V9V-n3G-v6.js | e2ae470004348b36e4ca22ee42ec4039051ad2e432bad0e03c8a9232866e1111 |

Public and origin page bytes match. Compiled-code inspection confirmed the
successful-array check, confirmed-scope branches, two positive-row revision
increments, empty-read revision comparison and existing coalesced reload latch.
This verifies publication and compiled behavior; it does not prove live device
acceptance. The adjacent JSON contains the exact public URLs and release receipt.

## Remaining Acceptance

The supported controlled browser again timed out after 20000ms while listing
tabs. Natural reconnect and physical iPad/PWA acceptance remain unverified.
No alternate browser-control mechanism was used.

The earlier production run 34435949773 tested c41635319207842a45b9dc65d87ba9f00da130ed
and ended canceled. Cashier had one pass and one failure: the Open Cashier For
menu was absent after a right-click and a five-second assertion at
production-cashier.spec.ts:109. Four lobby tests reached their 30-second
timeouts with page/context/browser-closed errors. WebKit continuity checks
did not establish acceptance: three tournament cases reported pre-existing
stalled tables, and the cash case lacked an eligible occupied running fixture.
Cleanup verified the isolated account absent at 05:14:29 UTC; report upload
failed with HTTP 403 because the job was completed.

Those failures do not establish a Phase 15 cause. Source review identified a
possible Cashier test readiness race: visibility precedes wallet-directory
hydration; aria-haspopup=menu is the existing eligibility marker. The missing
runtime artifact prevents attributing the observed failure to that race.
No speculative application or test change was made.

The separate release coordinator retains engine and Stage-B ownership. No
engine/container/tag/host mutation, live balance/seat probe, forced workflow
retry, manual PR opening/merging or hook bypass was used. The reference guard
blocked an unpushed rebase; it was aborted, and main was integrated by a normal
merge with the original repair retained.
