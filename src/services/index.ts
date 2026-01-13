/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 SERVICES — Index Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Club & Union Management
export { ClubsService } from './ClubsService';
// ClubService uses named export as object
export * from './ClubService';
// UnionService uses named export as object
export * from './UnionService';

// Table & Room Management
export * from './TableService';
export * from './RoomService';

// Tournament System
export { tournamentService, BLIND_STRUCTURES, PAYOUT_STRUCTURES } from './TournamentService';

// Agent & Financial Services
export * from './AgentService';
export * from './WalletService';

// Rake & Commissions
export { RakeService } from './RakeService';
export type { RakeCalculation, RakeAttribution, WaterfallResult, DealtInPlayer } from './RakeService';
export * from './CommissionService';
export * from './SettlementService';
export * from './CreditService';

// BBJ & Jackpots
export { BBJService } from './BBJService';
export type { BBJPool, BBJContribution, BBJPayout, BBJTriggerResult } from './BBJService';

// Leaderboards & Stats
export { LeaderboardService } from './LeaderboardService';
export type { LeaderboardEntry, PlayerStats, LeaderboardPeriod, LeaderboardMetric } from './LeaderboardService';

// Bot Liquidity (Hydra)
export { HydraService } from './HydraService';
export type { HorsePlayer, HydraConfig, BotProfile, TableLiquidityStatus, BotDecision, HandContext } from './HydraService';

// Arena & Training
export * from './ArenaLobbyEngine';
export * from './ArenaTrainingController';

// Audio
export * from './SoundService';

// Permissions & Admin
export { PermissionService } from './PermissionService';
export type { AdminLevel, Permission, UserPermissions, PermissionCheck } from './PermissionService';

// WebSocket / Real-Time
export { TableWebSocket, useTableWebSocket } from './TableWebSocket';
export type {
    GameEventType,
    GameEvent,
    PlayerPresence,
    TablePresenceState,
    UseTableWebSocketResult,
} from './TableWebSocket';

// Real-Time Channels (Club, Tournament, Hand)
export { realtimeChannelService, RealtimeChannelService } from './RealtimeChannelService';
export type {
    ChannelType,
    ClubPresence,
    ClubEvent,
    TournamentEvent,
    HandEvent
} from './RealtimeChannelService';
