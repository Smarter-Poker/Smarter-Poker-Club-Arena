/**
 * ♠ CLUB ARENA — Poker Engine Index
 * ═══════════════════════════════════════════════════════════════════════════════
 * Export all poker engine functionality
 */

// Core utilities
export {
  SUITS,
  RANKS,
  RANK_VALUES,
  HAND_RANKINGS,
  Deck,
  cardToString,
  cardsToString,
  parseCard,
  evaluateHand,
  evaluateOmahaHand,
  compareHands,
  calculatePots,
  calculateBettingState,
  validateAction,
  calculateRake,
  calculateTimedRake,
  determineWinners,
  type EvaluatedHand,
  type Pot,
  type Winner,
  type RakeConfig,
  type TimedRakeConfig,
  type BettingState,
} from './PokerEngine';

// Crypto Random
export { secureRandomInt, secureRandom, secureShuffle } from './CryptoRandom';

// Hand Controller
export {
  HandController,
  type HandConfig,
  type GameState,
  type ActionRecord,
  type HandEvent,
  type ShowdownResult,
} from './HandController';

// Horse Logic
export { HorseLogic, type TablePosition } from './HorseLogic';

// OFC removed — Open Face Chinese was removed from Club Arena

// Disconnect Engine
export {
  disconnectEngine,
  type DisconnectConfig,
  type PlayerConnectionState,
} from './DisconnectEngine';

// Time Bank Engine
export { timeBankEngine, type TimeBankConfig, type PlayerTimeBank } from './TimeBankEngine';

// Insurance Engine
export { insuranceEngine, type InsuranceConfig, type InsuranceOffer } from './InsuranceEngine';

// Mixed Game Engine
export { mixedGameEngine, MIXED_GAME_PRESETS, type MixedGameConfig } from './MixedGameEngine';

// Chip Race Engine
export { chipRaceEngine, type ChipRaceResult } from './ChipRaceEngine';

// Pre-Action Engine
export { preActionEngine, type PreActionType, type PreActionEntry } from './PreActionEngine';

// Rakeback Engine
export {
  rakebackEngine,
  DEFAULT_RAKEBACK_TIERS,
  type RakebackConfig,
  type RakebackTier,
} from './RakebackEngine';

// Hand Replay Engine
export {
  handReplayEngine,
  type ReplayAction,
  type ReplaySnapshot,
  type HandReplayData,
} from './HandReplayEngine';

// Horse Brain Adapter
export { HorseBrainAdapter, type RebuyStrategy } from './HorseBrainAdapter';

// Server Action Validator
export {
  serverActionValidator,
  type ActionRequest,
  type ValidationContext,
  type ValidationResult,
  type ValidatedActionType,
} from './ServerActionValidator';

// Atomic Stack Service
export {
  atomicStackService,
  type StackVersion,
  type StackSettlement,
  type AtomicResult,
  type BatchSettlementResult,
} from './AtomicStackService';

// Precise Action Timer
export { preciseActionTimer, type ActionDeadline } from './PreciseActionTimer';

// State Verifier
export {
  stateVerifier,
  type VerificationContext,
  type VerificationResult,
  type IntegrityViolation,
} from './StateVerifier';

// Evaluator Cache Control
export { clearEvalCache } from './PokerEngine';

// Engine Telemetry
export {
  engineTelemetry,
  type TableMetrics,
  type GlobalMetrics,
  type TelemetrySnapshot,
} from './EngineTelemetry';

// Table Balancer
export {
  tableBalancer,
  type BalancerTable,
  type BalancerPlayer,
  type MoveInstruction,
  type BalanceScore,
} from './TableBalancer';
