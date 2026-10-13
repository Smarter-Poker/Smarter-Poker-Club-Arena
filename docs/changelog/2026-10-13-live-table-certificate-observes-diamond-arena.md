# Live-table certificate observes Diamond Arena

The post-deploy spectator certificate inherited the general SHARK CLUB fixture after its tables closed. The assigned Diamond Arena has active natural tables, so the live-table Playwright step now explicitly selects its club through the existing E2E_CLUB_ID contract. Global setup uses the same target through the public player join flow; the continuity spec uses it for lobby discovery and engine liveness scope. No admin role, balance, game, schedule, engine or database change is introduced. The independent client/operator lane keeps its existing fixture.

The retained workflow regression failed before the environment correction. It binds setup, discovery and scoped health to the same target and retains authenticated execution, single-worker/no-retry checks and separation from the operator lane. Actual gameplay, connection, timing and cleanup assertions remain unchanged. Hosted continuity is required before claiming live certification.
