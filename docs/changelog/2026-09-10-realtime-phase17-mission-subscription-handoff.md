# Phase 17: Daily Missions Subscription Handoff

The first successful realtime subscription previously marked Daily Missions live
without checking whether a dashboard update had arrived between the initial
read and subscription acknowledgement. Reconnecting from a degraded state
already reconciled; a normal first subscription could leave the initial
snapshot stale until the recovery watchdog ran.

Each initial SUBSCRIBED acknowledgement now checks the existing server revision
cursor. A newer revision enters the existing coalesced dashboard refresh path,
including its queue for a read already in flight. A current or absent cursor
does not cause another full dashboard read. Reconnection retains the existing
recovery path. A subscription epoch rejects late cursor replies after channel
retirement, account change, or page unmount. Cursor failures preserve the last
confirmed dashboard and leave the existing watchdog available.

## Verification

Seven mounted cases exercise the real page: a missed initial update, an
already-current cursor, an update during the initial read, unmount retirement,
a failed cursor read, an absent revision, and retirement followed by another
subscription. The missed-update cases failed before the repair. All seven
pass afterward. Together with the existing freeze, realtime, receipt and
revision safety cases, 29 tests across five files pass.

TypeScript and the full build pass at base
5e441fe621797aa89c93b407130359ef820ea39c. Local build validation disables optional
Sentry source-map upload; normal publication remains with the repository
release pipeline. This entry records implementation evidence, not a claim of
publication or physical-device acceptance.

No database schema or realtime ownership mechanism changed. The existing
revision query and refresh scheduler remain the authority. Production release
evidence will be recorded separately after publication.
