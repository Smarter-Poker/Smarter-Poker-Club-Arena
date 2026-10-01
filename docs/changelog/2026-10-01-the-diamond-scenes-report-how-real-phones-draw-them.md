# The Diamond scenes report how real phones draw them (2026-10-01)

Phase 2 of the mobile graphics programme.

Every test of the Crash, Plinko and Donkey Cross scenes ran on a computer imitating a phone. Each scene visit now sends one short, anonymous summary to the product analytics the app already uses (`src/lib/analytics.ts`: PostHog, only after the player's consent, and nothing at all where no key is configured), so the real picture is known without anyone opening the Device Check. The work is in `src/components/games/sceneTelemetry.ts`.

- **`diamond_scene_session`**, sent when the player leaves the scene: the game, the kind of device (iPhone browser, Android browser, the app on iPhone or Android, or a computer), the screen's pixel ratio, whether the GPU or the CPU draws, the quality tier the scene started and ended on, the frames a second it held while moving, its share of slow frames, and how the device can buzz. Only moving frames count (the 30 a second between rounds and any pause are left out), and a visit with too little motion to measure sends nothing.
- **`diamond_scene_failed`**, sent when a scene cannot draw: the game, the reason (WebGL would not start, the graphics context was lost, or a reveal stalled with no frame for eight seconds, reported once per stall) and the kind of device.

Nothing personal is sent: no account, club or amounts. The scene kit now exposes its quality tier and whether the CPU draws it, which is what the summary reads.

Tests: `tests/unit/sceneTelemetry.test.ts` (the summary's numbers, motion only, nothing for a short visit, the failure report, the device kind) and `tests/components/DiamondGamesSound.test.tsx` (Plinko reports a renderer it could not start; Crash and Plinko close their summary on unmount).
