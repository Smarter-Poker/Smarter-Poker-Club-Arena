/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE COMPONENTS — Index Exports
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Core Table Components
export { default as ActionPanel } from './ActionPanel';
export { default as BuyInModal } from './BuyInModal';
export type { BuyInModalProps } from './BuyInModal';

// Player Seat Components
export { SeatSlot } from './SeatSlot';
export type {
  SeatPlayer,
  SeatSlotProps,
  Card as SeatCard,
  PlayerStatus,
  PositionBadge,
  LastAction,
} from './SeatSlot';

// Pot Display
export { PotDisplay } from './PotDisplay';
export type { PotDisplayProps, SidePot, PotDisplayMode } from './PotDisplay';

// Dealer Button
export { DealerButton } from './DealerButton';
export type { DealerButtonProps } from './DealerButton';

// Community Cards
export { CommunityCards } from './CommunityCards';
export type { CommunityCardsProps, Card as BoardCard, BoardStage } from './CommunityCards';

// Player Cards (Hole Cards)
export { PlayerCard, HoleCards } from './PlayerCard';
export type { PlayerCardProps, HoleCardsProps, Card } from './PlayerCard';

// Real-Time Results Panel
export { RealTimeResults } from './RealTimeResults';
export type { RealTimeResultsProps, TableInfo, SessionStats, Observer } from './RealTimeResults';

// Chip Stack (Betting Chips)
export { ChipStack } from './ChipStack';
export type { ChipStackProps } from './ChipStack';

// Premium Card (3D Cards with deck themes)
export { default as PremiumCard, CardPlaceholder, DECK_THEMES } from './PremiumCard';
export type { DeckTheme, PremiumCardType } from './PremiumCard';

// Timer Bar (Action Clock)
export { TimerBar } from './TimerBar';
export type { TimerBarProps } from './TimerBar';

// Table Chat
export { TableChat } from './TableChat';
export type { TableChatProps, ChatMessage, ChatMessageType } from './TableChat';

// Chat Bubble — the sent message shown over the sender's seat avatar
export {
  ChatBubble,
  useSeatChatBubbles,
  bubbleForSeat,
  CHAT_BUBBLE_LIFETIME_MS,
} from './ChatBubble';
export type { ChatBubbleProps, SeatChatBubble } from './ChatBubble';

// Wait List Modal
export { WaitListModal } from './WaitListModal';
export type { WaitListModalProps, WaitListPlayer } from './WaitListModal';

// Sit Out Modal
export { SitOutModal } from './SitOutModal';
export type { SitOutModalProps } from './SitOutModal';

// Cashier Modal
export { CashierModal } from './CashierModal';
export type { CashierModalProps, CashierTransaction, CashierTab } from './CashierModal';

// Settings Panel
export { SettingsPanel, DEFAULT_TABLE_SETTINGS } from './SettingsPanel';
export type { SettingsPanelProps, TableSettings } from './SettingsPanel';

// Leaderboard Panel
export { LeaderboardPanel } from './LeaderboardPanel';
export type {
  LeaderboardPanelProps,
  LeaderboardPlayer,
  LeaderboardPeriod,
} from './LeaderboardPanel';

// Tournament Break Screen
export { TournamentBreakScreen } from './TournamentBreakScreen';
export type {
  TournamentBreakScreenProps,
  TournamentPlayer,
  BlindLevel,
} from './TournamentBreakScreen';

// Rabbit Hunt (See undealt cards)
export { RabbitHunt } from './RabbitHunt';
export type { RabbitHuntProps, Card as RabbitCard } from './RabbitHunt';

// Hand Notation (Export format)
export { HandNotation } from './HandNotation';
export type {
  HandNotationProps,
  NotationHand,
  NotationPlayer,
  NotationAction,
} from './HandNotation';

// Share Hand (premium-style sharing)
export { ShareHand, encodeHand, decodeHandFromUrl } from './ShareHand';
export type {
  ShareHandProps,
  ShareableHand,
  ShareablePlayer,
  ShareableCard,
  ShareableAction,
} from './ShareHand';

// Hand Replay Player (Visual replayer)

// Table Menu (Hamburger menu)
export { TableMenu, createDefaultMenuSections } from './TableMenu';
export type { TableMenuProps, MenuSection, MenuAction, TableMenuObserver } from './TableMenu';

// Player Stats Popup
export { PlayerStats } from './PlayerStats';
export type {
  PlayerStatsProps,
  PlayerStatistics,
  PlayerSessionStats,
  PlayerNote,
} from './PlayerStats';

// Run It Twice
export { RunItTwicePrompt, RunItTwiceBoard } from './RunItTwice';
export type { RunItTwicePromptProps, RunItTwiceBoardProps } from './RunItTwice';

// Insurance Modal
export { InsuranceModal } from './InsuranceModal';
export type { InsuranceModalProps, InsuranceOffer } from './InsuranceModal';

// Game Rules Modal
export { GameRulesModal } from './GameRulesModal';
export type { GameRulesModalProps, TableRule } from './GameRulesModal';

// REMOVED 2026-08-20: TipDealer. Dealer tipping is not a feature of this
// platform and will not be reintroduced — see the note in WalletService.

// Time Bank
export { TimeBank } from './TimeBank';
export type { TimeBankProps } from './TimeBank';

// Straddle Toggle
export { StraddleToggle } from './StraddleToggle';
export type { StraddleToggleProps } from './StraddleToggle';

// Bad Beat Jackpot
export { BadBeatJackpot } from './BadBeatJackpot';
export type { BadBeatJackpotProps } from './BadBeatJackpot';

// VIP Table Settings (extends SettingsPanel with VIP gating)
export { TableSettings as VIPTableSettings } from './TableSettings';
export type { TableSettingsState as VIPTableSettingsState } from './TableSettings';

// Bible V8 §11.1: Reusable Table Settings Panel (12 toggles)
export { TableSettingsPanel } from './TableSettingsPanel';
export type { TableSettingsPanelProps } from './TableSettingsPanel';

// Theme Selector
export { ThemeSelector } from './ThemeSelector';

// Time Bank Display
export { TimeBankDisplay } from './TimeBankDisplay';

// Emoji Picker
export { EmojiPicker } from './EmojiPicker';

// Session Stats Tracker
export { SessionStatsTracker } from './SessionStatsTracker';

// Quick Action Bar
// REMOVED 2026-08-20: QuickActionBar, PreActionPanel and InsurancePanel.
// All three were unreferenced anywhere in src/ or tests/ — QuickActionBar only
// survived through this barrel, which nothing imported it from. QuickActionBar
// also shipped two buttons with no content and no handler, so any surface that
// had rendered it would have shown the player two dead squares.

// Mini-HUD (Opponent Statistics)
export { default as MiniHUD } from './MiniHUD';
export type { MiniHUDProps, MiniHUDStats } from './MiniHUD';

// Pot Odds Calculator
export { default as PotOddsDisplay } from './PotOddsDisplay';
export type { PotOddsDisplayProps } from './PotOddsDisplay';

// Equity Display (All-In) - Multi-Player Support
export { EquityBar, MultiPlayerEquityDisplay } from './EquityDisplay';
export type { EquityBarProps, MultiPlayerEquityDisplayProps } from './EquityDisplay';

// Hand History Panel
export { default as HandHistoryPanel } from './HandHistoryPanel';
export type {
  HandHistoryPanelProps,
  HandRecord,
  HandHistoryStreet,
  HandHistoryAction,
} from './HandHistoryPanel';

// Theme Settings Modal (Bible V8 §11.2)
export { ThemeSettingsModal } from './ThemeSettingsModal';
export type { ThemeSettingsModalProps } from './ThemeSettingsModal';

// Table HUD — 4-Corner Overlay Layout
export { TableHUD } from './TableHUD';
export type { TableHUDProps } from './TableHUD';

// Mini Stats Card — Upper-Right HUD Widget
export { MiniStatsCard } from './MiniStatsCard';
export type { MiniStatsCardProps, MiniStatsObserver } from './MiniStatsCard';

// Previous Hand Card — Bottom-Left HUD Widget
export { PreviousHandCard } from './PreviousHandCard';
export type { PreviousHandCardProps } from './PreviousHandCard';

// Deal Animation — Card dealing visual on new hand
export { DealAnimation } from './DealAnimation';
export type { DealAnimationProps } from './DealAnimation';
