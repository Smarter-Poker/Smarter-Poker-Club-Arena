# Waitlist offers through the real SDK and mounted consumers

The original waitlist repair remembers each offered deadline instead of relying on `old.status`, which can be absent from an RLS-protected Postgres Changes update. Existing coverage tested the decision function; it did not connect the actual SDK decoder to the mounted global listener and banner.

`tests/unit/globalWaitlistSdkTransport.test.tsx` now mounts the real GlobalWaitlistListener, MasterBus, useMasterBusSubscription and WaitlistBanner. The actual WaitlistService reads FIFO positions through the installed Supabase SDK and local HTTP server. Actual local WebSocket frames use the SDK's Postgres Changes binding handshake and carry only the old primary key. The fixture checks both scoped subscriptions, another player's queue-position update, a new named offer without navigation, duplicate suppression, a changed hold deadline, survival past the old deadline, cold reload from the authoritative fixture row and channel teardown. The auth/session identity and toast boundary are local test doubles; unused application-store initialization is isolated. The message handlers, event bus, service queries and rendered banner are not replaced.

All HTTP operations in this fixture must be reads. It does not access production, create seats, move chips, alter roles, advance a production clock or generate a real offer. This closes the local transported consumer gap; it does not claim production WAL/RLS delivery, a natural live seat offer, browser-engine interoperability or database producer qualification. Existing production fixture limitations remain explicit.

The existing required CI client matrix runs `npx vitest run tests/ --shard=N/4`, including this test via `vitest.config.ts`. Test path changes select that matrix. No new workflow, scheduler or application polling is introduced.

Real-time law: the existing `table_waitlist` update causes the actual named `WAITLIST_SEAT_OFFERED` / `WAITLIST_POSITION_CHANGED` consumer updates. No application behavior or visual design changes.

Local validation: 17 focused tests passed. Reintroducing the original `old.status` dependency in the owned local source made the connected fixture fail on the second toast; the original source bytes were restored and verified before the passing run. Compiler and lint passed. Full-suite and protected delivery outcomes are recorded with the release evidence.
