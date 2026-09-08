# Throwable Overflow Playback

Receivers discarded every delivered throwable after twelve active animations. A successful paid sender broadcast could therefore animate locally and disappear for another player. The delivery callback does not retry a throw when a slot opens.

`useTableAnimations` now keeps excess events in arrival order and promotes them from `handleThrowComplete`. Active rendering stays capped at twelve for both local and received events. Pending events mount only when a slot opens, preserving their full animation and sound clock. Duplicate and unknown completion callbacks cannot advance the queue. Table/account changes clear both active and queued playback.

Receipt deduplication checks queued and active identities as well as the bounded completed-history window, so a queued receipt cannot duplicate when the 512-entry history rolls over. Legacy messages remain independent. This is client delivery handling, not authenticated receipt validation or durable delivery across navigation/reload. Queued event metadata remains in memory until playback or a scope change; it has no drop-on-capacity limit.

Validation: full TypeScript and the production build pass. 105 focused tests across three files pass, including ten hook behavior tests, animation laws, and measured grammar. Coverage includes FIFO draining without redelivery, duplicate completion, queued receipt replay, local broadcasts at capacity, table/account changes, and a 526-event history-rollover burst.

Continuation scope recovered from current source: 80 unique catalogue IDs, 50 enabled picker items, 49 integrated atlas rigs plus the separate glove. File presence is not final acceptance. Additional catalogue integration, organic/voice audio, server item entitlements and table/target-bound authenticated receipts, final visual acceptance, and real multiplayer/device/Safari validation remain separate unfinished work. Recovered saved artwork checkpoint is preserved; this change does not replace it.
