# Phase 16 Cashier Production Acceptance

## Verified Outcome

The Cashier directory and viewport repair is published and passed both unchanged
production Cashier cases. This closes the Cashier menu clipping defect, not the
whole realtime programme or physical-device acceptance.

PR #4154 merged as `f1992eeb825918d6614d72a10c66988d0cdd292c` on September 10,
2026 at 08:44:53 UTC. Publisher 34456839305 verified origin adoption at
08:48:37 UTC. The saved public/origin byte inspection at 08:49:26 UTC verified
the referenced HomePage JavaScript and CSS, body portal, fixed anchor, and
mobile safe-area rules.

## Exact-Release Production Evidence

[Run 34457185978](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/34457185978),
job 102814181929, used the same `f1992eeb825918d6614d72a10c66988d0cdd292c`
for checkout, LIVE, specifications, and harness. Both Cashier tests passed at
09:17:01 UTC, with zero failures, skips, or retries:

- The Trade surface opened its first visible tab.
- The wallet directory opened by right-click and mobile hold without overflow.

The unchanged canary, blob `e58392b600c54465db30b1f8dd7a57b7e4a0d0ad`, checked
readiness, right-click, Escape dismissal, and a mobile hold at 320 by 700 pixels.
It asserted all four menu boundaries and document width. Successful numerical
coordinates were not printed, so none are inferred here. The gesture used
synthetic pointer events in Chromium, not a physical iPad.

The database contract and authenticated rolled-back RPC checks passed. The
runner provisioned an isolated account and verified its hard deletion and
absence at 09:39:18 UTC. Evidence collection during this resumption was read-only;
the earlier acceptance run itself included controlled test-account mutations.

The full run executed 292 cases: 286 passed and six failed, with two additional
skips and zero flaky results across 34 files. The overall workflow was a failure.

| Remaining Failure In That Run | Meaning                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| MTT, SPIN, SNG continuity     | Engine `8aaa7182` differed from expected client `f1992eeb`; continuity observation did not run.                     |
| Cash continuity               | No eligible running, occupied table with at least two players and a read-only View Table action.                    |
| Daily Missions                | `#daily-missions` was absent at the post-purchase assertion, after the repaired Terms/profile preflight had passed. |
| Mobile touch targets          | Choose Arena measured 32px/24px reachable; two promotion dots measured 6px/0px reachable.                           |

## Subsequent Publication Check

At 13:03:08 UTC, fresh public and origin reads both served
`6105b6f5b7ba708728949e92809d6f5981f33d19`, a descendant of the tested repair.
The referenced public and origin HomePage JavaScript and CSS matched. The portal,
anchor, and mobile safe-area markers remained present. The stylesheet SHA-256
remained `77d0223265b0f1e7fe545b0f142052dce8f2f0323ef706c371ac23151bd6afda`.
This is publication evidence, not a new rendered acceptance run.

The browser connection still timed out while refreshing tabs, including a
single fresh-tab retry. That limits direct UI inspection in this session and
does not establish a site outage.

## Remaining Programme Acceptance

Keep exact client/engine release alignment and Stage-B with the coordinator of
PR #3908. Preserve its existing release prerequisite. Obtain an eligible cash
fixture, complete natural reconnect and physical iPad/PWA acceptance, and obtain
the detailed PostgreSQL logs and per-service egress evidence recorded in the
Supabase follow-through. Track Daily Missions and mobile touch corrections by
their own feature evidence. Phase 16 and the whole programme are not certified
100% complete.

This receipt supersedes only the pending Cashier publication/viewport statements
in `2026-09-10-realtime-acceptance-follow-through.md` and the older Phase 16
release receipt. Historical failure records remain valid for their dated runs.
