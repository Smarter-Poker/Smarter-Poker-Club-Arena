import { supabase } from '../lib/supabase';
import { BBJService } from './BBJService';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
// [MIGRATION] rakebackEngine removed — server-authoritative (Step 6). Rakeback tracked via DB RPC.

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  RAKE WATERFALL ENGINE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Complete rake management implementing the financial laws:
 *
 * LOCKED SCALING LAWS (Hard Law):
 * - 10% Rake Law: Flat 10.00% of Total Pot (No Flop, No Drop)
 * - 2.5x Cap Law: Rake Cap = Big Blind × 2.5
 * - 0.5x BBJ Law: BBJ Drop = Big Blind × 0.5
 *
 * WATERFALL FLOW:
 * 1. Calculate Rake & BBJ from pot
 * 2. Execute Pot Drops (RPC)
 * 3. Attribute Rake to Dealt-In Players
 * 4. Queue Commission Credits → Monday Settlement
 *
 * CORE LAWS:
 * 1. Rake is taken from Pot
 * 2. Rake is split EVENLY among DEALT-IN players
 * 3. Sitting Out = ZERO Credit
 * 4. No Flop = No Drop
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface RakeCalculation {
  potSize: number;
  bigBlind: number;
  rakePercent: number;
  rawRake: number;
  cappedRake: number;
  rakeCap: number;
  bbjDrop: number;
  totalDeduction: number;
  netPot: number;
}

export interface RakeAttribution {
  userId: string;
  tableId: string;
  handId: string;
  rakeCredit: number;
  timestamp: string;
}

export interface WaterfallResult {
  handId: string;
  tableId: string;
  calculation: RakeCalculation;
  attributions: RakeAttribution[];
  bbjContributed: boolean;
  commissionsQueued: boolean;
}

export interface DealtInPlayer {
  userId: string;
  agentId?: string;
  clubId: string;
  isSittingOut: boolean;
  hasCards: boolean;
  wentToFlop: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFICIAL RAKE CHART — Stake-Based Tiers (DO NOT MODIFY)
// ═══════════════════════════════════════════════════════════════════════════════

interface RakeTier {
  sb: number;
  bb: number;
  rakePercent: number;
  maxAmount: number; // Cap in chips
  bbjRakeBB: number; // BBJ drop in BB units
  mainBBJ: number; // % of BBJ drop → Main pool
  backupBBJ: number; // % of BBJ drop → Backup pool
  promotional: number; // % of BBJ drop → Promo pool
}

const RAKE_CHART: RakeTier[] = [
  {
    sb: 0.1,
    bb: 0.2,
    rakePercent: 0.1,
    maxAmount: 3,
    bbjRakeBB: 0.6,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 0.2,
    bb: 0.4,
    rakePercent: 0.1,
    maxAmount: 3,
    bbjRakeBB: 0.6,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 0.25,
    bb: 0.5,
    rakePercent: 0.1,
    maxAmount: 3,
    bbjRakeBB: 0.6,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 0.3,
    bb: 0.6,
    rakePercent: 0.1,
    maxAmount: 5,
    bbjRakeBB: 0.6,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 0.5,
    bb: 1.0,
    rakePercent: 0.1,
    maxAmount: 5,
    bbjRakeBB: 0.25,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 1.0,
    bb: 2.0,
    rakePercent: 0.1,
    maxAmount: 5,
    bbjRakeBB: 0.25,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 2.0,
    bb: 4.0,
    rakePercent: 0.1,
    maxAmount: 7.5,
    bbjRakeBB: 0.12,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 2.0,
    bb: 5.0,
    rakePercent: 0.1,
    maxAmount: 7.5,
    bbjRakeBB: 0.12,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 5.0,
    bb: 5.0,
    rakePercent: 0.1,
    maxAmount: 7.5,
    bbjRakeBB: 0.12,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 3.0,
    bb: 6.0,
    rakePercent: 0.1,
    maxAmount: 8,
    bbjRakeBB: 0.12,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 4.0,
    bb: 8.0,
    rakePercent: 0.1,
    maxAmount: 10,
    bbjRakeBB: 0.12,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 5.0,
    bb: 10.0,
    rakePercent: 0.1,
    maxAmount: 12.5,
    bbjRakeBB: 0.06,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 10.0,
    bb: 20.0,
    rakePercent: 0.1,
    maxAmount: 15,
    bbjRakeBB: 0.06,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
  {
    sb: 10.0,
    bb: 25.0,
    rakePercent: 0.1,
    maxAmount: 15,
    bbjRakeBB: 0.06,
    mainBBJ: 0.4,
    backupBBJ: 0.3,
    promotional: 0.3,
  },
];

/** Look up the correct rake tier for given blinds — falls back to closest match */
function getRakeTier(smallBlind: number, bigBlind: number): RakeTier {
  // Exact match first
  const exact = RAKE_CHART.find((t) => t.sb === smallBlind && t.bb === bigBlind);
  if (exact) return exact;

  // Closest by big blind
  let closest = RAKE_CHART[0];
  let minDiff = Math.abs(bigBlind - closest.bb);
  for (const tier of RAKE_CHART) {
    const diff = Math.abs(bigBlind - tier.bb);
    if (diff < minDiff) {
      minDiff = diff;
      closest = tier;
    }
  }
  return closest;
}

const RAKE_LAWS = {
  RAKE_PERCENT: 0.1, // 10% of pot (universal)
  TOURNAMENT_RAKE: 0.1, // Flat 10% on tournament buy-ins
  MIN_POT_FOR_RAKE: 0, // Minimum pot size to take rake
} as const;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const RakeService = {
  /**
   * CALCULATE RAKE & BBJ
   * Implements the Locked Scaling Laws
   */
  calculateRake(
    potSize: number,
    bigBlind: number,
    wentToFlop: boolean = true,
    smallBlind?: number
  ): RakeCalculation {
    const sb = smallBlind ?? bigBlind / 2;
    const tier = getRakeTier(sb, bigBlind);

    // NO FLOP, NO DROP rule
    if (!wentToFlop) {
      return {
        potSize,
        bigBlind,
        rakePercent: tier.rakePercent,
        rawRake: 0,
        cappedRake: 0,
        rakeCap: tier.maxAmount,
        bbjDrop: 0,
        totalDeduction: 0,
        netPot: potSize,
      };
    }

    // Integer arithmetic (×100) to avoid floating point — use trunc, never round
    const potScaled = Math.trunc(potSize * 100);

    // Raw rake = rakePercent of pot
    const rawRakeScaled = Math.trunc(potScaled * tier.rakePercent);

    // Cap from chart (scaled ×100)
    const rakeCapScaled = Math.trunc(tier.maxAmount * 100);
    const cappedRakeScaled = Math.min(rawRakeScaled, rakeCapScaled);

    // BBJ drop = bbjRakeBB × BB (in BB units → chips → scaled ×100)
    const bbjDropChips = tier.bbjRakeBB * bigBlind;
    const bbjDropScaled = Math.trunc(bbjDropChips * 100);

    // Total deduction from pot
    const totalDeductionScaled = cappedRakeScaled + bbjDropScaled;

    return {
      potSize,
      bigBlind,
      rakePercent: tier.rakePercent,
      rawRake: rawRakeScaled / 100,
      cappedRake: cappedRakeScaled / 100,
      rakeCap: tier.maxAmount,
      bbjDrop: bbjDropScaled / 100,
      totalDeduction: totalDeductionScaled / 100,
      netPot: Math.max(0, potSize - totalDeductionScaled / 100),
    };
  },

  /** Get the BBJ split percentages for given stakes */
  getBBJSplit(
    smallBlind: number,
    bigBlind: number
  ): { main: number; backup: number; promo: number } {
    const tier = getRakeTier(smallBlind, bigBlind);
    return { main: tier.mainBBJ, backup: tier.backupBBJ, promo: tier.promotional };
  },

  /** Get the rake tier for given stakes */
  getTier(smallBlind: number, bigBlind: number): RakeTier {
    return getRakeTier(smallBlind, bigBlind);
  },

  /**
   * EXECUTE WATERFALL
   * Main entry point - orchestrates the full rake flow
   */
  async executeWaterfall(params: {
    handId: string;
    tableId: string;
    clubId: string;
    unionId?: string;
    smallBlind?: number;
    potSize: number;
    bigBlind: number;
    wentToFlop: boolean;
    players: DealtInPlayer[];
    /** If provided, use this pre-calculated rake from HandController instead of re-calculating.
     *  Ensures rake is based on the FINAL pot at hand end (single source of truth). */
    preCalculatedRake?: number;
  }): Promise<WaterfallResult> {
    const { handId, tableId, clubId, unionId, potSize, bigBlind, wentToFlop, players } = params;
    const sb = params.smallBlind ?? bigBlind / 2;

    // STEP 1: Calculate rake and BBJ using official stake-based chart
    const calculation = this.calculateRake(potSize, bigBlind, wentToFlop, sb);

    // If HandController already calculated rake from the FINAL pot, use that as authority
    if (typeof params.preCalculatedRake === 'number' && params.preCalculatedRake >= 0) {
      calculation.cappedRake = params.preCalculatedRake;
      // Recalculate BBJ drop proportionally based on the authoritative rake
      if (calculation.rawRake > 0) {
        const ratio = params.preCalculatedRake / calculation.rawRake;
        calculation.bbjDrop = Math.trunc(calculation.bbjDrop * ratio * 100) / 100;
      }
      calculation.totalDeduction = calculation.cappedRake + calculation.bbjDrop;
      calculation.netPot = potSize - calculation.totalDeduction;
    }

    // STEP 2: Execute pot drops (if there's rake to take)
    if (calculation.cappedRake > 0) {
      const potDropSuccess = await this.executePotDrops({
        handId,
        tableId,
        clubId,
        unionId,
        rakeAmount: calculation.cappedRake,
        bbjAmount: calculation.bbjDrop,
        potSize,
        numPlayers: players.length,
      });

      // ABORT waterfall if pot drops failed — cannot attribute rake that was never collected
      if (!potDropSuccess) {
        reportError(new Error('Pot drops failed'), 'RakeService.potDrops', { handId });
        return {
          handId,
          tableId,
          calculation,
          attributions: [],
          bbjContributed: false,
          commissionsQueued: false,
        };
      }
    }

    // STEP 3: Attribute rake to dealt-in players
    const attributions = await this.distributeHandRake(
      tableId,
      handId,
      calculation.cappedRake,
      players
    );

    // STEP 3.5: Record per-player contributions to DB for server-side rakeback
    if (calculation.cappedRake > 0 && attributions.length > 0 && clubId) {
      try {
        // Build contribution map from rake attributions (each attribution has userId + share)
        const contributions = new Map<string, number>();
        for (const attr of attributions) {
          const existing = contributions.get(attr.userId) || 0;
          contributions.set(attr.userId, existing + attr.rakeCredit);
        }

        // Persist rake attributions to DB — server's RakebackEngine handles settlement
        const attrPayload = attributions.map((a) => ({
          user_id: a.userId,
          rake_amount: a.rakeCredit,
          pot_contribution: contributions.get(a.userId) || 0,
        }));
        supabase
          .rpc('record_hand_rake_attribution', {
            p_hand_id: params.handId || null,
            p_table_id: params.tableId || null,
            p_club_id: clubId,
            p_attributions: attrPayload,
          })
          .then(({ error: attrErr }) => {
            if (attrErr) reportError(attrErr, 'RakeService.Rake_attribution_persist');
          });
      } catch (rbErr) {
        reportError(rbErr, 'RakeService.rakebackRecording');
      }
    }

    // STEP 4: Queue commission credits
    let commissionsQueued = false;
    if (calculation.cappedRake > 0 && attributions.length > 0) {
      commissionsQueued = await this.queueCommissionCredits({
        handId,
        clubId,
        tableId,
        rakeAmount: calculation.cappedRake,
        players: players.filter((p) => !p.isSittingOut && p.hasCards),
      });
    }

    // STEP 5: Record BBJ contribution
    let bbjContributed = false;
    if (calculation.bbjDrop > 0) {
      try {
        let pool = await BBJService.getPool({ unionId, clubId });

        // Auto-create pool if missing (backward compatibility)
        if (!pool && clubId) {
          pool = await BBJService.ensurePoolExists(clubId);
        }

        if (pool) {
          const result = await BBJService.recordContribution({
            poolId: pool.id,
            handId,
            tableId,
            bigBlind,
            currentMainBalance: pool.main_balance,
            bbjDrop: calculation.bbjDrop, // Pass tier-based amount to avoid mismatch
          });
          bbjContributed = result !== null;
          if (!result) {
            console.debug(
              `[RakeService] BBJ contribution failed for hand ${handId} — pool ${pool.id}`
            );
          }
        } else {
          // CRITICAL: BBJ money was already deducted from pot but has no pool destination.
          // Log with maximum severity so this can be detected and reconciled.
          console.debug(
            `[RakeService] No BBJ pool found for club ${clubId}, hand ${handId}. ` +
              `BBJ drop of ${calculation.bbjDrop.toFixed(2)} — pool not yet configured.`
          );
        }
      } catch (e: unknown) {
        reportError(e, 'RakeService.bbjContribution', { handId });
      }
    }

    // STEP 6: Update union total_rake if this club belongs to a union
    // Use atomic RPC when available, fallback to read-modify-write
    if (calculation.cappedRake > 0 && unionId) {
      try {
        // Try atomic increment RPC first (safe for concurrent hands)
        const { error: rpcError } = await retryAsync(
          () =>
            supabase.rpc('increment_union_rake', {
              p_union_id: unionId,
              p_amount: calculation.cappedRake,
            }),
          3
        );

        // Fallback: direct PostgREST read-modify-write
        if (rpcError) {
          const { data: unionRow } = await supabase
            .from('unions')
            .select('total_rake')
            .eq('id', unionId)
            .maybeSingle();
          const currentRake = Number(unionRow?.total_rake) || 0;
          const { error: fallbackErr } = await supabase
            .from('unions')
            .update({ total_rake: currentRake + calculation.cappedRake })
            .eq('id', unionId);
          if (fallbackErr) {
            reportError(fallbackErr, 'RakeService.unionTotalRake.fallback', { unionId });
          }
        }
      } catch (e: unknown) {
        reportError(e, 'RakeService.unionTotalRake', { unionId });
      }
    }

    return {
      handId,
      tableId,
      calculation,
      attributions,
      bbjContributed,
      commissionsQueued,
    };
  },

  /**
   * EXECUTE POT DROPS
   * Atomically deduct rake and BBJ from pot
   */
  async executePotDrops(params: {
    handId: string;
    tableId: string;
    clubId: string;
    unionId?: string;
    rakeAmount: number;
    bbjAmount: number;
    potSize?: number;
    numPlayers?: number;
  }): Promise<boolean> {
    // Direct INSERT into rake_records (bypasses broken execute_pot_drops RPC)
    const { error } = await supabase.from('rake_records').insert({
      hand_id: params.handId,
      table_id: params.tableId,
      club_id: params.clubId,
      rake_amount: params.rakeAmount,
      bbj_contribution: params.bbjAmount,
      pot_size: params.potSize || 0,
      num_players: params.numPlayers || 0,
    });

    if (error) {
      reportError(error, 'RakeService.executePotDrops');
      return false;
    }

    return true;
  },

  /**
   * DISTRIBUTE RAKE CREDIT
   * Split rake evenly among dealt-in players.
   * NOTE: rake_records INSERT is already handled by executePotDrops().
   * This method calculates per-player attribution and updates
   * club_members.rake_generated for each player.
   */
  async distributeHandRake(
    tableId: string,
    handId: string,
    totalRake: number,
    players: DealtInPlayer[]
  ): Promise<RakeAttribution[]> {
    // Filter to active players only
    const activePlayers = players.filter((p) => !p.isSittingOut && p.hasCards);

    if (activePlayers.length === 0 || totalRake === 0) {
      return [];
    }

    // Calculate equal split using integer arithmetic (×100) to avoid floating point loss
    const totalRakeScaled = Math.trunc(totalRake * 100);
    const baseCreditScaled = Math.trunc(totalRakeScaled / activePlayers.length);
    const remainderScaled = totalRakeScaled - baseCreditScaled * activePlayers.length;
    const timestamp = new Date().toISOString();

    // Build attribution records — distribute remainder 1 unit at a time
    const attributions: RakeAttribution[] = activePlayers.map((p, i) => {
      const extra = i < remainderScaled ? 1 : 0;
      return {
        userId: p.userId,
        tableId,
        handId,
        rakeCredit: (baseCreditScaled + extra) / 100,
        timestamp,
      };
    });

    // Update each player's rake_generated in club_members.
    // Try atomic RPC first, fall back to read-modify-write if RPC doesn't exist.
    const clubId = players[0]?.clubId;
    if (clubId) {
      for (const attr of attributions) {
        try {
          // Attempt atomic increment via RPC (safest for multi-table horses)
          const { error: rpcError } = await retryAsync(
            () =>
              supabase.rpc('increment_rake_generated', {
                p_club_id: clubId,
                p_user_id: attr.userId,
                p_amount: attr.rakeCredit,
              }),
            3
          );

          // Fallback: read-modify-write
          if (rpcError) {
            const resolvedClubId = await resolveClubUUID(clubId);
            const { data: memberRow } = await supabase
              .from('club_members')
              .select('total_rake_paid')
              .eq('club_id', resolvedClubId)
              .eq('user_id', attr.userId)
              .maybeSingle();
            const currentRake = Number(memberRow?.total_rake_paid) || 0;
            const { error: fallbackErr } = await supabase
              .from('club_members')
              .update({ total_rake_paid: currentRake + attr.rakeCredit })
              .eq('club_id', resolvedClubId)
              .eq('user_id', attr.userId);
            if (fallbackErr) {
              reportError(fallbackErr, 'RakeService.distributeHandRake.allFailed', { userId: attr.userId, rakeCredit: attr.rakeCredit });
            }
          }
        } catch (e: unknown) {
          reportError(e, 'RakeService.distributeHandRake', { userId: attr.userId });
        }
      }
    }

    return attributions;
  },

  /**
   * QUEUE COMMISSION CREDITS
   * Stage rake credits for Monday settlement payout
   */
  async queueCommissionCredits(params: {
    handId: string;
    clubId: string;
    rakeAmount: number;
    players: DealtInPlayer[];
    tableId?: string;
  }): Promise<boolean> {
    // Guard against division by zero
    if (params.players.length === 0 || params.rakeAmount <= 0) return true;

    try {
      // Group players by agent for commission attribution
      // Use integer (×100) arithmetic to avoid floating-point loss
      const byAgentScaled = new Map<string, number>();
      const totalRakeScaled = Math.trunc(params.rakeAmount * 100);
      const perPlayerScaled = Math.trunc(totalRakeScaled / params.players.length);
      const remainderScaled = totalRakeScaled - perPlayerScaled * params.players.length;

      let playerIdx = 0;
      for (const player of params.players) {
        if (player.agentId) {
          // Distribute remainder 1 unit at a time to first N players
          const extra = playerIdx < remainderScaled ? 1 : 0;
          const current = byAgentScaled.get(player.agentId) || 0;
          byAgentScaled.set(player.agentId, current + perPlayerScaled + extra);
        }
        playerIdx++;
      }

      // Convert back to chips
      const byAgent = new Map<string, number>();
      for (const [agentId, scaled] of byAgentScaled) {
        byAgent.set(agentId, scaled / 100);
      }

      // No agents at this table — nothing to credit
      if (byAgent.size === 0) {
        console.debug(
          `[RakeService] No agent-linked players in hand ${params.handId.substring(0, 8)}... ` +
            `(${params.players.length} players, rake=$${params.rakeAmount.toFixed(2)})`
        );
        return true;
      }

      // Increment each agent's rake_generated in the agents table
      // This provides real-time tracking; weekly settlement reads from here
      for (const [agentId, rakeCredit] of byAgent) {
        try {
          // Try atomic RPC first
          const { error: rpcError } = await retryAsync(
            () =>
              supabase.rpc('increment_agent_rake', {
                p_agent_id: agentId,
                p_amount: rakeCredit,
              }),
            3
          );

          // Log rake commission to chip_ledger for audit trail
          supabase
            .from('chip_ledger')
            .insert({
              performed_by: agentId,
              from_type: 'player_wallet',
              from_label: 'Table Rake Pool',
              to_type: 'agent_wallet',
              to_entity_id: agentId,
              to_label: `Agent ${agentId.slice(0, 8)} commission`,
              amount: rakeCredit,
              category: 'commission',
              description: `Rake commission: ${rakeCredit.toFixed(2)} chips from hand ${params.handId?.slice(0, 8) || 'unknown'}`,
              table_id: params.tableId || undefined,
              hand_id: params.handId || undefined,
              club_id: params.clubId || undefined,
            })
            .then(({ error: le }) => {
              if (le) reportError(le, 'RakeService.chipLedgerWrite');
            });

          // Fallback: read-modify-write for agent lifetime_rake_generated
          // NOTE: agents table has lifetime_rake_generated, NOT rake_generated
          if (rpcError) {
            const { data: agentRow } = await supabase
              .from('agents')
              .select('lifetime_rake_generated')
              .eq('user_id', agentId)
              .maybeSingle();
            const currentRake = Number(agentRow?.lifetime_rake_generated) || 0;
            const { error: fallbackErr } = await supabase
              .from('agents')
              .update({ lifetime_rake_generated: currentRake + rakeCredit })
              .eq('user_id', agentId);
            if (fallbackErr) {
              reportError(fallbackErr, 'RakeService.agentRake.fallback', { agentId });
            }
          }
        } catch (e: unknown) {
          // Non-blocking: commission tracking should never break the hand pipeline
          reportError(e, 'RakeService.creditAgent');
        }
      }

      return true;
    } catch (err: unknown) {
      reportError(err, 'RakeService.commissionQueue');
      return false;
    }
  },

  /**
   * CALCULATE TOURNAMENT RAKE
   * Law: Flat 10% on Buy-in
   */
  calculateTournamentRake(buyIn: number): { rake: number; prizePoolContribution: number } {
    const rake = buyIn * RAKE_LAWS.TOURNAMENT_RAKE;
    const contribution = buyIn - rake;

    return {
      rake,
      prizePoolContribution: contribution,
    };
  },

  /**
   * GET SCALING MATRIX
   * Reference table for stake-based caps
   */
  getScalingMatrix(): {
    stakeLevel: string;
    bigBlind: number;
    rakeCap: number;
    bbjDrop: number;
    mainBBJ: number;
    backupBBJ: number;
    promo: number;
  }[] {
    return RAKE_CHART.map((t) => ({
      stakeLevel: `${t.sb} / ${t.bb}`,
      bigBlind: t.bb,
      rakeCap: t.maxAmount,
      bbjDrop: t.bbjRakeBB * t.bb,
      mainBBJ: t.mainBBJ,
      backupBBJ: t.backupBBJ,
      promo: t.promotional,
    }));
  },

  /**
   * GET LAWS
   * Expose rake laws for external reference
   */
  getLaws(): typeof RAKE_LAWS {
    return { ...RAKE_LAWS };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-14: TOURNAMENT RAKE TRACKING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record tournament buy-in fee as rake revenue.
   * Called when a tournament collects buy-ins (fee portion = house revenue).
   *
   * @param tournamentId - Tournament UUID
   * @param clubId - Club that hosts the tournament
   * @param totalBuyInFees - Total fee revenue (summed across all registrants)
   * @param playerCount - Number of registered players
   * @param buyInAmount - Individual buy-in (for auditing)
   * @param feePerPlayer - Individual fee per player (for auditing)
   */
  async recordTournamentRake(params: {
    tournamentId: string;
    clubId: string;
    totalBuyInFees: number;
    playerCount: number;
    buyInAmount: number;
    feePerPlayer: number;
  }): Promise<boolean> {
    if (params.totalBuyInFees <= 0) return true;

    try {
      // 1. Record in rake_records for unified financial reporting
      const { error: insertErr } = await retryAsync(
        () =>
          supabase.from('rake_records').insert({
            table_id: null,
            hand_id: null,
            club_id: params.clubId,
            pot_size: params.buyInAmount * params.playerCount,
            rake_amount: params.totalBuyInFees,
            bbj_contribution: 0,
            num_players: params.playerCount,
            // Tournament tracking columns (added by 20260314_schema_gap_remediation)
            source: 'tournament',
            tournament_id: params.tournamentId,
            metadata: {
              playerCount: params.playerCount,
              buyInAmount: params.buyInAmount,
              feePerPlayer: params.feePerPlayer,
            },
          }),
        3
      );

      if (insertErr) {
        reportError(insertErr, 'RakeService.recordTournamentRake');
        return false;
      }

      // 2. Also credit the club's total rake (for settlement calculations)
      try {
        const { error: rpcError } = await retryAsync(
          () =>
            supabase.rpc('increment_club_rake', {
              p_club_id: params.clubId,
              p_amount: params.totalBuyInFees,
            }),
          3
        );

        if (rpcError) {
          reportError(rpcError, 'RakeService.incrementClubRake');
        }
      } catch (err) {
        reportError(err, 'RakeService.incrementClubRake.outer');
        /* RPC may not exist — non-blocking */
      }
      return true;
    } catch (err: unknown) {
      reportError(err, 'RakeService.recordTournamentRake.outer');
      return false;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // P2-20: RAKE RATE CHANGE AUDIT LOG
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Log a rake rate change for audit trail.
   */
  async logRateChange(params: {
    clubId: string;
    changedBy: string;
    oldRate: number;
    newRate: number;
    rateType: string;
    notes?: string;
  }): Promise<void> {
    try {
      await supabase.from('rake_rate_audit').insert({
        club_id: params.clubId,
        changed_by: params.changedBy,
        old_rate: params.oldRate,
        new_rate: params.newRate,
        rate_type: params.rateType,
        notes: params.notes,
        created_at: new Date().toISOString(),
      });
    } catch (err) {
      reportError(err, 'RakeService.logRateChange');
    }
  },
};

export default RakeService;
