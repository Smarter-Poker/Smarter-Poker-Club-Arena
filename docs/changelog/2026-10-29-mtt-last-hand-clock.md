# Preserve the tournament last-hand phase in the event bridge

The server's `tournament_break` last-hand announcement carries a planned duration but no deadline. `src/services/tournamentEventBridge.ts` forwarded that duration as `durationMinutes`, so the real TournamentClock fabricated a countdown before tables finished their last hands. The bridge now omits the duration for an explicit `last_hand` phase. Countdown-start events retain their authoritative end and legacy duration-only events retain their existing meaning.

The bridge regression fails before the repair and passes afterward. A connected test renders the real TournamentClock through the bridge and bus, verifies no last-hand timer, the absolute countdown (including elapsed time), and release. The focused bridge/clock/HUD suite passes 55 tests. This changes presentation only and uses the existing engine event contract; no new engine activation is required. Publication and live verification are separate pending steps.

Real-time law: triggered by `tournament_break`, `tournament_break_started` and `break_ended` discrete events, no snapshot diff. No new polling or repair process is introduced. Existing TournamentClock polling is unchanged and is not this repair's source of correctness.
