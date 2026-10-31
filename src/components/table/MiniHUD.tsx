/**
 * Retired opponent HUD compatibility boundary.
 * Owner direction 2026-10-28: opponent statistics and classifications never render.
 * Retain the public counter type for hand-stat recording, and refuse rendering
 * even when a stale caller passes isVisible=true. No settings can enable it.
 */

export interface MiniHUDStats {
  handsPlayed: number;
  vpipCount: number; // Voluntarily Put In Pot
  pfrCount: number; // Pre-Flop Raise
  aggressiveActions?: number;
  callActions?: number;
  aggressionMeasured?: boolean;
  threeBetCount: number; // 3-bet frequency
  cBetCount: number; // Continuation bet
  wtsdCount: number; // Went To ShowDown
  wonCount: number; // Hands won
  totalBuyIn: number; // Total bought in
  totalCashOut: number; // Total cashed out
}

export interface MiniHUDProps {
  stats: MiniHUDStats | null;
  isVisible: boolean;
  compact?: boolean; // Ultra-compact mode for small screens
}

export default function MiniHUD(_props: MiniHUDProps): null {
  return null;
}
