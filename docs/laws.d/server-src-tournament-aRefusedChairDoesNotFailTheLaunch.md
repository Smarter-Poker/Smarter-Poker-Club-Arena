# server/src/tournament/aRefusedChairDoesNotFailTheLaunch.law.test.ts

A tournament launch seats its roster one atomic RPC at a time, and until
2026-09-09 the first refused seat threw: the launch receipt stayed incomplete,
the event stayed REGISTERING, and everybody else sat on felt that never dealt
(19 events, 881 seats, a day). Each refusal is now answered on its own - a stale
chair is retried, a seated or unregistered player is skipped, and a registrant
the platform cannot seat at start is released with his exact refund through
`fn_ca_release_unseatable_registrant_at_launch` (service-only, requires the
event's incomplete launch receipt, refuses a player holding a live seat, settles
through `fn_ca_unregister_tournament_player_exact` under a deterministic
request id). The launch fails closed only when a refused registrant could not be
released or a seat outcome is unknown.
