/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SERVICES — Index Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Club & Union Management
export { ClubsService } from './ClubsService';
// NOTE: ClubService is DEPRECATED — use ClubsService for all club operations.
// ClubService is still importable directly for its unique methods (updateChipBalance,
// handleMembershipRequest, etc.) but is no longer re-exported from the barrel.
// UnionService uses named export as object
export * from './UnionService';
// MembershipService for member management & permissions
export { MembershipService, ROLE_HIERARCHY, ROLE_DISPLAY_NAMES } from './MembershipService';
export type { ClubMembership, MemberRole, MemberStatus } from './MembershipService';

// Table & Room Management
export * from './TableService';
export * from './RoomService';

// Tournament System
export { tournamentService, BLIND_STRUCTURES, PAYOUT_STRUCTURES } from './TournamentService';

// Promotions & Campaigns
export { promotionService } from './PromotionService';
export type {
  Promotion,
  PromotionClaim,
  LeaderboardEntry as PromotionLeaderboardEntry,
} from './PromotionService';

// Achievements & Gamification
export { achievementService, ACHIEVEMENTS } from './AchievementService';
export type {
  Achievement,
  UserAchievement,
  AchievementCategory,
  AchievementRarity,
} from './AchievementService';

// Agent & Financial Services
export * from './AgentService';
export * from './WalletService';

// Rake & Commissions
export { RakeService } from './RakeService';
export type {
  RakeCalculation,
  RakeAttribution,
  WaterfallResult,
  DealtInPlayer,
} from './RakeService';
export * from './CommissionService';
export * from './SettlementService';
export * from './CreditService';

// BBJ & Jackpots
export { BBJService } from './BBJService';
export type { BBJPool, BBJContribution, BBJPayout, BBJTriggerResult } from './BBJService';

// Leaderboards & Stats
export { LeaderboardService } from './LeaderboardService';
export type {
  LeaderboardEntry,
  PlayerStats,
  LeaderboardPeriod,
  LeaderboardMetric,
} from './LeaderboardService';

// Horse Liquidity (Hydra)
export { HydraService } from './HydraService';
export type {
  HorsePlayer,
  HydraConfig,
  HorseProfile,
  TableLiquidityStatus,
  HorseDecision,
  HandContext,
} from './HydraService';

// Arena & Training
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
  HandEvent,
} from './RealtimeChannelService';

// Hand History
export { handHistoryService, HandHistoryService } from './HandHistoryService';
export type { HandRecord, HandPlayer, HandAction } from './HandHistoryService';

// GTO Query Engine
export { GTOQueryService } from './GTOQueryService';
export type { GTOSolution, PreflopRange } from './GTOQueryService';

// Avatar Management
export { avatarService } from './AvatarService';

// Bonus & Rewards
export { bonusService } from './BonusService';
export type { DailyBonus, SpecialBonus, BonusStatus } from './BonusService';

// Messaging & Notifications
export { messagingService } from './MessagingService';
export type { Message, Conversation, MessageReaction } from './MessagingService';
export { notificationService } from './NotificationService';
export type { Notification } from './NotificationService';

// Presence & Social
export { presenceService } from './PresenceService';
export { profileService } from './ProfileService';

// Waitlist Management
export { waitlistService } from './WaitlistService';

// VIP Subscriptions & Feature Gating
export { vipService, VIP_GOLD_LIMITS, FEATURE_PRICING } from './VIPService';
export type { VIPStatus, VIPMonthlyLimits, VIPFeature, FeatureAccess } from './VIPService';

// Player Notes
export { playerNotesService, NOTE_COLORS, PLAYER_TAGS } from './PlayerNotesService';
export type { PlayerNote } from './PlayerNotesService';

// Credit Requests
export { creditRequestService } from './CreditRequestService';
export type { CreditRequest, CreditRequestCreate } from './CreditRequestService';

// Push Notifications
export { pushNotificationService } from './PushNotificationService';

// Cashout
export { cashoutService } from './CashoutService';

// Daily Challenges
export { dailyChallengeService } from './DailyChallengeService';

// Player of the Year
export { POYService } from './POYService';

// Hand Persistence
export { handPersistenceService } from './HandPersistenceService';

// Tournament Timer
export { tournamentTimerService } from './TournamentTimerService';

// Achievement Triggers
export { achievementTriggerService } from './AchievementTriggerService';

// Payout Engine (ICM, dynamic templates, overlay detection)
export { payoutEngine } from './PayoutEngine';
export type { PayoutEntry, PayoutTemplate, ICMResult, OverlayStatus } from './PayoutEngine';

// Session Stats (real-time P&L, VPIP/PFR, trajectory)
export { sessionStatsService } from './SessionStatsService';
export type { SessionStats } from './SessionStatsService';

// Disconnect Protection (heartbeat, grace period, offline queue)
export { disconnectProtectionService } from './DisconnectProtectionService';
export type { ConnectionState, DisconnectConfig, DCAction } from './DisconnectProtectionService';
