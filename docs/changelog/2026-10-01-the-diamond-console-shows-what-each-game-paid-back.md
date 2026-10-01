# The Diamond console shows what each game paid back, and the entry read stops repeating itself (2026-10-01)

Phase 3 of the mobile graphics programme: money and load.

**What each game paid back.** `fn_diamond_game_metrics` already returned the realised return per window and over the game's life, and each Plinko table's designed return, but the operations console never printed them. The Game Activity console now has a **Paid Back** column (chips paid out of chips taken in, per hour, day and week) where the Chips Paid figure used to repeat the "Out" line beside it. The readings console gains a **Paid Back** row for the game's whole life, next to what the game is **Built To Pay**: the live Plinko table's own figure, otherwise the 80 percent every Diamond game is designed to. Each Plinko table row states its designed return too. The rule lives in `src/utils/diamondDesignedReturn.ts`.

**Why Crash gets no rounds.** The database shows only test traffic on every Diamond game (75 rounds in total, none since 2026-09-22) and no client failures, so there is no Crash-specific break in the funnel to fix. The Phase 2 scene reports will show real play once players arrive.

**Database load.**

- `fn_diamond_games_entry` ran 4,717 times in three days of test traffic. `useDiamondGamesEntry` read it on mount, on window focus, on visibilitychange (focus and visibilitychange fire together on every tab return) and on every wallet or seat event. A tab return within 15 seconds of the last read now reads nothing (`RETURN_FRESH_MS`), and a burst of wallet and seat events is answered by one read 250 ms later (`EVENT_COALESCE_MS`). A wallet or seat event is never skipped, only merged, so the bust prompt and the Diamonds To Chips door still see every change.
- The per-minute Crash sweep (`fn_crash_sweep_abandoned`) costs about 25 ms a run, but its own work (finding open rounds) takes 0.3 ms: the rest is the fresh database session pg_cron opens every minute. An early exit inside the function cannot remove that, so the sweep is left as it is.

Tests: `tests/unit/diamondGamesEntryLoad.test.tsx` (a quick tab return reads nothing, a later one reads once, a burst of events reads once, nothing reads after unmount), `tests/unit/diamondDesignedReturn.test.ts` (the designed return, and the console prints both readings), and the two existing entry suites now wait out the burst window.
