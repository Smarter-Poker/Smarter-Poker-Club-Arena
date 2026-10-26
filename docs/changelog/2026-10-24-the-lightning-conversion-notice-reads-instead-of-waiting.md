# The Lightning conversion notice reads instead of waiting on a dead channel (2026-10-24)

Found by the Production Integrity Audit's realtime check: `src/lightning/useLightningAnchorHandoff.ts` waited for a realtime `UPDATE` on `cash_games` to learn that a seated player's game had converted, and `cash_games` is not in the `supabase_realtime` publication. The channel joined, reported `SUBSCRIBED` and never fired, so a player seated at a Lightning anchor table while the game was `pending_on` was offered **View Game** only if the page happened to remount.

Publishing `cash_games` is not the fix: it takes 19.5M updates against 266 rows (`pg_stat_user_tables`, read 2026-10-24), the exact shape of every table on the `KNOWN_UNPUBLISHED` baseline in `scripts/ci/check-realtime-publication.mjs`. `cash_cluster_events` is published but players cannot read it (no grant, row security with no policy).

So the hook reads the player's pool session once on mount, again every `LIGHTNING_LOBBY_REFRESH_MS` (30 s, the lobby feed's cadence) while the tab is visible, and immediately when the tab becomes visible, and stops as soon as the room is ready. It writes nothing. Classic games are untouched: the hook still runs only when TablePage hands it a Lightning game's id (Dan 2026-10-24, "no part of the Lightning games ... should be touching the Classic games").

Tests: `tests/lightning/lightning-phase-6-review-fixes.test.tsx` now drives the conversion by the clock and pins that no realtime channel is opened, that a hidden tab reads nothing until shown, and that reading stops once the room is ready.
