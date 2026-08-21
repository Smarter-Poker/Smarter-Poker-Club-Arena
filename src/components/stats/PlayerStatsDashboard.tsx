/**
 * REMOVED 2026-08-21. This file is intentionally empty.
 *
 * `PlayerStatsDashboard` was 315 lines of dead code. Nothing in the repo ever
 * imported it, and its state was seeded with hardcoded fake numbers
 * (`vpip: 24.5`, `pfr: 18.2`, `totalHands: 15420`, `totalProfit: 12500`) that
 * rendered as if they were a real player's results. Anyone opening it while
 * looking for the stats page would have found a plausible-looking dashboard
 * that was never wired to anything and whose numbers were invented.
 *
 * It also held the repo's only recharts `RadarChart` usage, which made it look
 * like the starting point for a positional radar. It was not.
 *
 * WHERE THE REAL THINGS LIVE
 *   - The page itself:        src/pages/PlayerStatsPage.tsx
 *   - Positional radar:       src/components/stats/PositionalRadar.tsx
 *   - Playstyle radar:        src/components/stats/PlayerStyleRadar.tsx
 *   - Animation variants:     src/components/stats/statsMotion.ts
 *
 * The file is kept as a stub rather than deleted outright so this note is
 * findable by anyone who has the old path in a bookmark, a stale branch, or a
 * search result. Delete it freely in any commit that can drop files.
 */

export {};
