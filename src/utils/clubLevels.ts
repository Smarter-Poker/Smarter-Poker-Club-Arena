/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB & UNION LEVELS SYSTEM (1-50 PokerBros Style)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Two independent axes drive club level:
 *   - Player Count  → player_level      (30 * 1.125^(L-1))
 *   - Hierarchy     → hierarchy_level   (2 * 1.086^(L-1))
 *
 * hierarchy_units = admins*1.0 + super_agents*1.0 + agents*0.25
 *
 * Final level = MAX(player_level, hierarchy_level, 1), capped at 50.
 * Levels are fully dynamic — they go up AND down based on current state.
 *
 * The UI reads threshold pairs from the DB and shows a progress bar for the
 * dominant axis (whichever contributes the higher sub-level).
 */

export type ClubTier =
  | 'starter'
  | 'small'
  | 'growing'
  | 'established'
  | 'large'
  | 'regional'
  | 'major'
  | 'network'
  | 'enterprise'
  | 'elite';

export interface ClubLevelInfo {
  level: number;
  tier: ClubTier;
  tierLabel: string;
  progressPercent: number;
  color: string;
  gradient: string;
  playerLevel?: number;
  hierarchyLevel?: number;
}

export interface ClubLevelInput {
  level?: number;
  playerLevel?: number;
  hierarchyLevel?: number;
  playerCount?: number;
  hierarchyUnits?: number;
  hierarchyUnitsRoundedUp?: number;
  playerThresholdCurrent?: number;
  playerThresholdNext?: number;
  hierarchyThresholdCurrent?: number;
  hierarchyThresholdNext?: number;
  // Legacy compat — ignored by the formula but some old callsites still pass them
  memberCount?: number;
  activeTables?: number;
  tournamentsHosted?: number;
  totalHandsPlayed?: number;
  totalRakeGenerated?: number;
  isInUnion?: boolean;
  clubAgeDays?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIER MAPPING (Section J of spec)
// ═══════════════════════════════════════════════════════════════════════════════

// 1-5   = Starter          | 6-10  = Small Club
// 11-15 = Growing Club     | 16-20 = Established
// 21-25 = Large Club       | 26-30 = Regional Operator
// 31-35 = Major Operator   | 36-40 = Network-Grade Club
// 41-45 = Enterprise Club  | 46-50 = Elite Network Operator

export function getTierForLevel(level: number): ClubTier {
  if (level >= 46) return 'elite';
  if (level >= 41) return 'enterprise';
  if (level >= 36) return 'network';
  if (level >= 31) return 'major';
  if (level >= 26) return 'regional';
  if (level >= 21) return 'large';
  if (level >= 16) return 'established';
  if (level >= 11) return 'growing';
  if (level >= 6) return 'small';
  return 'starter';
}

const TIER_LABELS: Record<ClubTier, string> = {
  starter: 'Starter',
  small: 'Small Club',
  growing: 'Growing Club',
  established: 'Established',
  large: 'Large Club',
  regional: 'Regional Operator',
  major: 'Major Operator',
  network: 'Network-Grade Club',
  enterprise: 'Enterprise Club',
  elite: 'Elite Network Operator',
};

const TIER_COLORS: Record<ClubTier, string> = {
  starter: '#CD7F32', // Bronze
  small: '#C0C0C0', // Silver
  growing: '#87CEEB', // Sky Blue
  established: '#4682B4', // Steel Blue
  large: '#FFD700', // Gold
  regional: '#FFA500', // Orange
  major: '#FF4500', // Red Orange
  network: '#8A2BE2', // Blue Violet
  enterprise: '#E5E4E2', // Platinum
  elite: '#00CED1', // Diamond/Cyan
};

const TIER_GRADIENTS: Record<ClubTier, string> = {
  starter: 'linear-gradient(135deg, #CD7F32 0%, #8B4513 100%)',
  small: 'linear-gradient(135deg, #C0C0C0 0%, #808080 100%)',
  growing: 'linear-gradient(135deg, #87CEEB 0%, #4682B4 100%)',
  established: 'linear-gradient(135deg, #4682B4 0%, #000080 100%)',
  large: 'linear-gradient(135deg, #FFD700 0%, #B8860B 100%)',
  regional: 'linear-gradient(135deg, #FFA500 0%, #FF8C00 100%)',
  major: 'linear-gradient(135deg, #FF4500 0%, #8B0000 100%)',
  network: 'linear-gradient(135deg, #8A2BE2 0%, #4B0082 100%)',
  enterprise: 'linear-gradient(135deg, #E5E4E2 0%, #A9A9A9 100%)',
  elite: 'linear-gradient(135deg, #B9F2FF 0%, #00CED1 100%)',
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT-SIDE THRESHOLD FORMULAS (mirrors SQL exactly)
// ═══════════════════════════════════════════════════════════════════════════════

/** player_threshold(L) = ROUND(30 * 1.125^(L-1)) */
export function computePlayerThreshold(level: number): number {
  return Math.round(30 * Math.pow(1.125, level - 1));
}

/** hierarchy_threshold(L) = ROUND(2 * 1.086^(L-1)) */
export function computeHierarchyThreshold(level: number): number {
  return Math.round(2 * Math.pow(1.086, level - 1));
}

/** Compute player_level from total_players (highest L where total_players >= threshold(L)) */
export function computePlayerLevel(totalPlayers: number): number {
  let lvl = 1;
  for (let L = 1; L <= 50; L++) {
    if (totalPlayers >= computePlayerThreshold(L)) {
      lvl = L;
    } else {
      break;
    }
  }
  return lvl;
}

/** Compute hierarchy_level from hierarchy_units_rounded_up */
export function computeHierarchyLevel(hierarchyUnitsRoundedUp: number): number {
  let lvl = 1;
  for (let L = 1; L <= 50; L++) {
    if (hierarchyUnitsRoundedUp >= computeHierarchyThreshold(L)) {
      lvl = L;
    } else {
      break;
    }
  }
  return lvl;
}

/**
 * Compute hierarchy_units from role counts.
 * admins count 1.0, super_agents count 1.0, agents/sub_agents count 0.25 each.
 */
export function computeHierarchyUnits(
  adminCount: number,
  superAgentCount: number,
  agentCount: number
): number {
  return adminCount * 1.0 + superAgentCount * 1.0 + agentCount * 0.25;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: getClubLevel
// ═══════════════════════════════════════════════════════════════════════════════

export function getClubLevel(input: ClubLevelInput): ClubLevelInfo {
  const currentLvl = Math.min(Math.max(input.level || 1, 1), 50);
  const pCount = Math.max(input.playerCount || 0, input.memberCount || 0);
  const hUnitsRaw = input.hierarchyUnitsRoundedUp ?? Math.ceil(input.hierarchyUnits || 0);

  // Determine sub-levels for display (prefer DB values, fallback to client compute)
  const playerLvl = input.playerLevel || computePlayerLevel(pCount);
  const hierarchyLvl = input.hierarchyLevel || computeHierarchyLevel(hUnitsRaw);

  // ── Progress calculation ──
  let progressPercent = 0;

  // Get thresholds — prefer DB-stored values, fallback to client-side compute
  const pT_curr = input.playerThresholdCurrent || computePlayerThreshold(playerLvl);
  const pT_next = input.playerThresholdNext || computePlayerThreshold(Math.min(playerLvl + 1, 50));
  const hT_curr = input.hierarchyThresholdCurrent || computeHierarchyThreshold(hierarchyLvl);
  const hT_next =
    input.hierarchyThresholdNext || computeHierarchyThreshold(Math.min(hierarchyLvl + 1, 50));

  // Player axis progress
  let p_prog = 0;
  if (pT_next > pT_curr) {
    p_prog = ((pCount - pT_curr) / (pT_next - pT_curr)) * 100;
  }

  // Hierarchy axis progress
  let h_prog = 0;
  if (hT_next > hT_curr) {
    h_prog = ((hUnitsRaw - hT_curr) / (hT_next - hT_curr)) * 100;
  }

  // Use the dominant axis (whichever is further along)
  progressPercent = Math.max(0, Math.min(100, Math.floor(Math.max(p_prog, h_prog))));

  // Max level = 100% progress
  if (currentLvl >= 50) progressPercent = 100;

  const tier = getTierForLevel(currentLvl);

  return {
    level: currentLvl,
    tier,
    tierLabel: TIER_LABELS[tier],
    progressPercent,
    color: TIER_COLORS[tier],
    gradient: TIER_GRADIENTS[tier],
    playerLevel: playerLvl,
    hierarchyLevel: hierarchyLvl,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNION LEVEL (same formula, same tiers)
// ═══════════════════════════════════════════════════════════════════════════════

export interface UnionLevelInput {
  level?: number;
  playerLevel?: number;
  hierarchyLevel?: number;
  totalPlayers?: number;
  hierarchyUnits?: number;
  hierarchyUnitsRoundedUp?: number;
  playerThresholdCurrent?: number;
  playerThresholdNext?: number;
  hierarchyThresholdCurrent?: number;
  hierarchyThresholdNext?: number;
}

export function getUnionLevel(input: UnionLevelInput): ClubLevelInfo {
  // Delegate to getClubLevel — identical formula, just wraps for type clarity
  return getClubLevel({
    level: input.level,
    playerLevel: input.playerLevel,
    hierarchyLevel: input.hierarchyLevel,
    playerCount: input.totalPlayers,
    hierarchyUnits: input.hierarchyUnits,
    hierarchyUnitsRoundedUp: input.hierarchyUnitsRoundedUp,
    playerThresholdCurrent: input.playerThresholdCurrent,
    playerThresholdNext: input.playerThresholdNext,
    hierarchyThresholdCurrent: input.hierarchyThresholdCurrent,
    hierarchyThresholdNext: input.hierarchyThresholdNext,
  });
}
