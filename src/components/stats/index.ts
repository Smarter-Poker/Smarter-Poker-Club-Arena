/**
 * Barrel for the stats components.
 *
 * Previously this exported only StatCard and StatGrid, so every substantial
 * component in this directory was imported by deep relative path while two
 * trivial ones had a front door. Everything a consumer can reasonably use is
 * exported here now.
 *
 * Retired 2026-09-04 (Stats Page Programme phase 2): PerformanceTrends,
 * StakeLevelComparison, PlayerStyleRadar and StatsExportButton were exported
 * and rendered nowhere; PlayerStyleRadar plotted six derived "personality"
 * axes that no measured stat backed. Their localStorage prefixes are still
 * reaped by staleCacheReaper so a player's storage is left clean.
 */

export { StatCard } from './StatCard';
export { StatGrid } from './StatGrid';

export { default as PositionalRadar } from './PositionalRadar';
export type { PositionalRadarRow } from './PositionalRadar';

export { default as EVLuckChart } from './EVLuckChart';
export { default as HoleCardHeatmap } from './HoleCardHeatmap';
export { default as NemesisPanel } from './NemesisPanel';
export { default as BenchmarkPanel } from './BenchmarkPanel';
export { default as TrophyRoom } from './TrophyRoom';
export { default as LeakPanel } from './LeakPanel';
export * from './findLeaks';
export * from './playerStyleFromStats';
export { default as StatsShareCard } from './StatsShareCard';
export * from './statBenchmarks';

export { default as AdvancedStatsSummary } from './AdvancedStatsSummary';
export { default as BankrollTracker } from './BankrollTracker';
export { default as PositionWinRates } from './PositionWinRates';
export { default as SessionHistory } from './SessionHistory';

export * from './statsMotion';
