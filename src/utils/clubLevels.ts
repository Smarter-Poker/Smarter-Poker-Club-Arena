/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CLUB & UNION LEVELS SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * TWO SYSTEMS LIVE HERE. Read this before using either.
 *
 * 1. THE CLUB LEVEL (1-55, member count only) — what a club card shows.
 *    getClubLevelFromMembers / getClubLevelInfoFromMembers, below. Added
 *    2026-08-20 at Dan's request. Mirrors public.club_level_thresholds.
 *
 * 2. The legacy dual-axis level (1-50), described below. Still used for the
 *    progress bars that read the DB's threshold columns, and still what the
 *    `clubs.level` column holds. NOT the number on the card any more.
 *
 * ── Legacy dual-axis system ──
 * Two independent axes drove club level:
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
  | 'elite'
  | 'legendary';

// ═══════════════════════════════════════════════════════════════════════════════
// THE 1-55 MEMBER-COUNT LADDER — Dan 2026-08-20
// ═══════════════════════════════════════════════════════════════════════════════
//
// "we need to create a true 'club level' level 1-55 that is determined based on
//  how many players are inside a club."
//
// The dual-axis formula above (players MAX hierarchy, capped at 50) is kept for
// the progress bars and for reading legacy DB columns, but it is no longer what
// decides the number on a club card. It could not be: a club levelled up by
// appointing agents, so the badge answered "how much structure does this club
// have" when every player reading it asks "how big is this club".
//
// These numbers are the MIRROR of public.club_level_thresholds (migration
// 20260821000500). If you change one you must change the other — the DB
// function fn_club_level_for_members and getClubLevelFromMembers below have to
// agree, or a card and a report will disagree about the same club.
//
// Shape of the curve: fast early so a new club sees the number move, brutal
// late so the top means something. 578 members -> 29, 1,156 -> 33, and 55
// requires 100,000.

/** min_members required to reach each level, index 0 = level 1. */
export const CLUB_LEVEL_THRESHOLDS: readonly number[] = [
  0, 5, 10, 15, 20, // 1-5    Starter
  25, 30, 35, 40, 45, // 6-10   Small Club
  50, 60, 70, 80, 90, // 11-15  Growing Club
  100, 110, 125, 140, 160, // 16-20  Established
  180, 200, 230, 270, 310, // 21-25  Large Club
  360, 420, 490, 570, 660, // 26-30  Regional Operator
  770, 900, 1050, 1200, 1400, // 31-35  Major Operator
  1650, 1900, 2200, 2600, 3000, // 36-40  Network-Grade Club
  3500, 4100, 4800, 5600, 6500, // 41-45  Enterprise Club
  7600, 8900, 10500, 12500, 15000, // 46-50  Elite Network Operator
  20000, 30000, 45000, 70000, 100000, // 51-55  Legendary Network
];

export const MAX_CLUB_LEVEL = CLUB_LEVEL_THRESHOLDS.length; // 55

/**
 * The club's level: the highest rung whose member requirement it has reached.
 *
 * Mirrors public.fn_club_level_for_members exactly.
 */
export function getClubLevelFromMembers(memberCount: number | null | undefined): number {
  const members = Math.max(0, Math.floor(memberCount ?? 0));
  let level = 1;
  for (let i = 0; i < CLUB_LEVEL_THRESHOLDS.length; i++) {
    if (members >= CLUB_LEVEL_THRESHOLDS[i]) level = i + 1;
    else break;
  }
  return level;
}

/** Members needed for the next level, or null at the cap. */
export function membersToNextClubLevel(memberCount: number | null | undefined): number | null {
  const members = Math.max(0, Math.floor(memberCount ?? 0));
  const level = getClubLevelFromMembers(members);
  if (level >= MAX_CLUB_LEVEL) return null;
  return Math.max(0, CLUB_LEVEL_THRESHOLDS[level] - members);
}

/** Full display info for a member-count-derived level. */
export function getClubLevelInfoFromMembers(memberCount: number | null | undefined): ClubLevelInfo {
  const members = Math.max(0, Math.floor(memberCount ?? 0));
  const level = getClubLevelFromMembers(members);
  const tier = getTierForLevel(level);

  const floor = CLUB_LEVEL_THRESHOLDS[level - 1];
  const ceiling = level < MAX_CLUB_LEVEL ? CLUB_LEVEL_THRESHOLDS[level] : floor;
  const progressPercent =
    level >= MAX_CLUB_LEVEL || ceiling <= floor
      ? 100
      : Math.max(0, Math.min(100, Math.floor(((members - floor) / (ceiling - floor)) * 100)));

  return {
    level,
    tier,
    tierLabel: TIER_LABELS[tier],
    progressPercent,
    color: TIER_COLORS[tier],
    gradient: TIER_GRADIENTS[tier],
    playerLevel: level,
  };
}

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
  // 51-55 is the new top band that came with the 1-55 member ladder. Reaching
  // it takes 20,000 members, so it is deliberately out of reach of anything on
  // the platform today.
  if (level >= 51) return 'legendary';
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
  legendary: 'Legendary Network',
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
  legendary: '#FF6FD8', // Legendary magenta
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
  legendary: 'linear-gradient(135deg, #FF6FD8 0%, #3813C2 100%)',
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
  const pCount = Math.max(input.playerCount || 0, input.memberCount || 0);

  /* Dan 2026-08-20 — the level a club SHOWS is now the member ladder.

     This used to return `input.level`: the stored clubs.level, a MAX() of the
     player curve and the hierarchy curve, clamped to 50. Six surfaces call
     this (club cards, discovery, the hamburger header, the club dashboard,
     the union page twice), so changing it here rather than at each callsite
     is what keeps them from disagreeing about the same club.

     The stored level is still honoured as a fallback for a caller that knows a
     level but not a member count — the union page's per-club rows, for one. */
  const currentLvl =
    pCount > 0
      ? getClubLevelFromMembers(pCount)
      : Math.min(Math.max(input.level || 1, 1), MAX_CLUB_LEVEL);
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
  if (currentLvl >= MAX_CLUB_LEVEL) progressPercent = 100;

  /* When we have a member count, the progress bar must measure the SAME ladder
     the level came from. Leaving it on the legacy dual-axis maths would show a
     bar filling toward a level the badge will never display. */
  if (pCount > 0) {
    progressPercent = getClubLevelInfoFromMembers(pCount).progressPercent;
  }

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
