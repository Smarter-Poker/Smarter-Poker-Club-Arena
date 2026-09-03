# 2026-08-28 — Bus wrapper bugs, the scanner blind spot, and nine dead subscriptions

## Wrapper bugs (handlers that ran and read the wrong object)

masterBus hands subscribers the EVENT WRAPPER ({ type, payload, timestamp }),
not the raw payload. Four live handlers read payload fields off the wrapper:

- AchievementTriggerService TOURNAMENT_REGISTERED — `payload?.userId` was
  always undefined, so it fell through to getAuthUser() and credited the
  tournament challenge to the LOCALLY signed-in user instead of the entrant,
  inverting the design intent stated directly above it. Fixed.
- ProfilePage DAILY_REWARD_CLAIMED / MISSION_CLAIMED — `.rewardType` off the
  wrapper, always undefined; the diamond-rain celebration never fired. Fixed.
- ProfilePage WHEEL_SPIN_RESULT — the most insidious variant: the WRAPPER has
  a real `.type` holding the event NAME, so `payload?.type === 'diamonds'`
  was silently, permanently false. Fixed to read .payload.type.

## The scanner blind spot

tests/unit/noDeadBusSubscriptions.test.ts matched only `masterBus.subscribe(`
— it could never see `masterBus.subscribeDebounced(`, the most common direct
idiom in the repo. One word in the regex hid nine subscriptions that nothing
emits. Fixed: `subscribe(?:Debounced)?`.

## The nine dead subscriptions (removed, per the test's own rule)

Each subscribed to an event with NO client-side emitter, so the handler had
never run once. Removed rather than added to KNOWN_DEAD; each site carries a
note. Revive any of them through a real server->client bridge
(tournamentEventBridge pattern), never by re-adding a bare subscription:

VIP_POINTS_UPDATED (VIPPage), COLLUSION_DETECTED (AdminDashboardPage,
FinancialAlertsPage, ClubDashboard), VALIDATION_MISMATCH
(FinancialAlertsPage), ANTI_CHEAT_FLAG_CREATED (AntiCheatPage), TABLE_MERGED
(TournamentDetails, TournamentLobbyPage), TABLE_BREAK_COMPLETED
(EngineDashboard — server emits engine-side only), TOURNAMENT_LEVEL_CHANGE
(XMTTPage — BlindsTab documents deliberate non-emission), GAME_STATE_UPDATED
(FlashPoolPage — the Supabase realtime channel below it is the working path),
PLAYER_JOINED (PlayerSessionsPage — RoomService's PLAYER_JOINED is a room
message type, a name collision).

## The decoy test

tests/verify-bus-listeners.test.ts never imported MasterBus — every test
asserted against a local reimplementation defined inside the test body, so it
passed regardless of what the real bus did. Rewritten against the real
MasterBus; it now pins the wrapper contract itself (including the .type trap)
for both subscribe and subscribeDebounced.
