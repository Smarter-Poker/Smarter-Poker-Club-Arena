# Realtime join admission

Cold Cashier, Player Management and Club Data subscriptions started the SDK's
10-second channel join deadline while the websocket was still connecting.
A bounded live anonymous control measured the transport opening at 15.164
seconds. All affected authenticated page channels timed out together even
though their HTTP reads succeeded. Opening/authenticating the actual locked
SDK transport before subscribing succeeded with its original join deadline.
The historical exact cause of the earlier auth lock wait remains unknown;
World Hub's independently reproduced callback starvation was fixed separately.

`supabase.ts` now supplies a supported native transport observer. The original
socket and SDK handlers, authentication, refresh lock, heartbeat and reconnect
remain owned by the SDK. `realtimeAdmission.ts` bounds transport and auth
readiness separately at 20 seconds (above the observed 15.164-second open),
then `subscribeRealtime.ts` starts the unchanged SDK join deadline. Admission
failure reaches existing error consumers and recovery; no repair loop, extra
refresher, socket restart, engine change or database change is added.

The row and broadcast hooks and global PostgresSync owner retain their existing
bindings and recovery registration, but cancel pending admission on replacement,
unmount and identity change. MasterBus accepts an expected-channel release so
a retired admission cannot decrement or remove a replacement owner's channel.
Existing private broadcast authorization is preserved; public row channels also
finish authentication before constructing their join payload.

Regression coverage uses actual RealtimeClient 2.90.1 with a controlled native
socket: immediate subscription demonstrably times out before the measured open;
admission spends no join budget until ready and retains the 10-second join
timeout. Tests cover auth/transport ordering, finite close/error/deadline,
cancellation, effect cleanup, identity replacement and expected-channel release.
Financial handlers, installed migrations and report query behavior are unchanged.

Real-time law: existing named Postgres Changes and private Broadcast events,
no snapshot diff. Publication and live acceptance are recorded in the task
checkpoint, separately from local qualification.
