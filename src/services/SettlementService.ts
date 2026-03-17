/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SETTLEMENT SERVICE — Weekly Financial Settlement Automation
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Handles Union Cross-Club Wires and Monday Payouts.
 *
 * SETTLEMENT CYCLE:
 * - Sunday 11:59:59 PM PST → Snapshot all ledgers
 * - Monday 4:00 AM PST → Process payouts
 *
 * FORMULA:
 * Wire = (Net Player P/L) + (Gross Rake Return) - (Union Tax 10%)
 */

import { supabase } from '../lib/supabase';
import { CommissionService } from './CommissionService';
import { WalletService } from './WalletService';
import { pushNotificationService } from './PushNotificationService';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { retryAsync } from '../utils/retryAsync';
// Use globalThis.crypto for browser-safe UUID generation
const generateUUID = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type SettlementStatus = 'open' | 'processing' | 'settled' | 'disputed';

export interface SettlementPeriod {
  id: string;
  periodNumber: number;
  year: number;
  startAt: string;
  endAt: string;
  status: SettlementStatus;
  totalRakeCollected: number;
  totalBBJContributions: number;
  totalPlayerWinnings: number;
  totalPlayerLosses: number;
  totalHandsDealt: number;
  settledAt?: string;
  settledBy?: string;
}

export interface ClubSettlement {
  id: string;
  periodId: string;
  clubId: string;
  clubName: string;
  totalRakeCollected: number;
  totalJackpotContributions: number;
  totalPromoCosts: number;
  uniquePlayers: number;
  totalHandsDealt: number;
  platformFee: number;
  agentCommissions: number;
  grossRevenue: number;
  netRevenue: number;
  status: 'pending' | 'finalized' | 'disputed';
}

export interface AgentSettlement {
  id: string;
  periodId: string;
  agentId: string;
  agentName: string;
  totalRakeGenerated: number;
  commissionRate: number;
  commissionEarned: number;
  creditExtended: number;
  creditRepaid: number;
  netSettlement: number;
  activePlayers: number;
  status: 'pending' | 'approved' | 'paid' | 'disputed';
}

export interface UnionWireCalculation {
  clubId: string;
  clubName: string;
  netPlayerPL: number;
  grossRake: number;
  unionTax: number;
  finalWire: number;
  action: 'COLLECT_FROM_UNION' | 'PAY_TO_UNION';
}

export interface SettlementSummary {
  period: SettlementPeriod;
  clubSettlements: ClubSettlement[];
  agentSettlements: AgentSettlement[];
  unionWires: UnionWireCalculation[];
  totalPlatformRevenue: number;
  totalAgentPayouts: number;
  totalPlayerRakeback: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

export const SettlementService = {
  // ─────────────────────────────────────────────────────────────────────────────
  // PERIOD MANAGEMENT
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get or create the current settlement period
   */
  async getCurrentPeriod(): Promise<SettlementPeriod> {
    const { data, error } = await retryAsync(
      () => supabase.rpc('get_current_settlement_period'),
      3
    );
    if (error) throw error;

    // RPC returns table - use first row or create default period
    if (data && data.length > 0) {
      const period = data[0];
      const periodId = period.id || generateUUID();
      if (!period.id) {
        console.warn(
          `[Settlement] RPC returned period but with null id. Generated fallback UUID: ${periodId}`
        );
      }
      return {
        id: periodId,
        periodNumber: 1,
        year: new Date().getFullYear(),
        startAt: period.period_start,
        endAt: period.period_end,
        status: period.status || 'open',
        totalRakeCollected: period.total_rake || 0,
        totalBBJContributions: 0,
        totalPlayerWinnings: 0,
        totalPlayerLosses: 0,
        totalHandsDealt: 0,
      };
    }

    // Return default empty period if none exists
    const periodId = generateUUID();
    console.warn(
      `[Settlement] CRITICAL: No settlement period found. Created fallback period ${periodId}. ` +
        `This settlement may be orphaned — verify period table.`
    );
    return {
      id: periodId,
      periodNumber: 1,
      year: new Date().getFullYear(),
      startAt: new Date().toISOString(),
      endAt: new Date().toISOString(),
      status: 'open',
      totalRakeCollected: 0,
      totalBBJContributions: 0,
      totalPlayerWinnings: 0,
      totalPlayerLosses: 0,
      totalHandsDealt: 0,
    };
  },

  /**
   * Get historical periods
   */
  async getPeriodHistory(limit: number = 12): Promise<SettlementPeriod[]> {
    const { data, error } = await supabase
      .from('settlement_periods')
      .select(
        'id, period_number, year, start_at, end_at, status, total_rake_collected, total_bbj_contributions, total_player_winnings, total_player_losses, total_hands_dealt, settled_at, settled_by'
      )
      .order('start_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data.map(this.mapPeriod);
  },

  /**
   * Close period and begin processing
   */
  async closePeriod(periodId: string): Promise<boolean> {
    const { error } = await supabase
      .from('settlement_periods')
      .update({ status: 'processing' })
      .eq('id', periodId);

    if (error) throw error;
    return true;
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // SETTLEMENT CALCULATIONS
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Calculate union wire for a club
   */
  calculateUnionWire(
    clubId: string,
    clubName: string,
    netPlayerPL: number,
    grossRake: number
  ): UnionWireCalculation {
    const unionTax = grossRake * 0.1; // 10% Union Tax
    const finalWire = netPlayerPL + grossRake - unionTax;

    return {
      clubId,
      clubName,
      netPlayerPL,
      grossRake,
      unionTax,
      finalWire,
      action: finalWire >= 0 ? 'COLLECT_FROM_UNION' : 'PAY_TO_UNION',
    };
  },

  /**
   * Generate all settlements for a period
   */
  async generateSettlements(periodId: string): Promise<SettlementSummary> {
    const { data, error } = await retryAsync(
      () =>
        supabase.rpc('generate_period_settlements', {
          p_period_id: periodId,
        }),
      3
    );

    if (error) throw error;
    return data;
  },

  /**
   * Calculate agent settlement for a specific agent
   */
  async calculateAgentSettlement(periodId: string, agentId: string): Promise<AgentSettlement> {
    try {
      // Try calculate_agent_settlement first
      const { data, error } = await retryAsync(
        () =>
          supabase.rpc('calculate_agent_settlement', {
            p_period_id: periodId,
            p_agent_id: agentId,
          }),
        3
      );

      if (error) {
        console.error(
          '[Settlement] calculate_agent_settlement not available, trying calculate_agent_spread'
        );
        // Fall back to calculate_agent_spread if available
        const { data: spreadData, error: spreadError } = await retryAsync(
          () =>
            supabase.rpc('calculate_agent_spread', {
              p_period_id: periodId,
              p_agent_id: agentId,
            }),
          3
        );

        if (!spreadError && spreadData) {
          return spreadData;
        }

        // Return default if both fail
        console.error('[Settlement] Falling back to default settlement');
        return {
          id: `${agentId}-${periodId}`,
          periodId,
          agentId,
          agentName: 'Unknown',
          totalRakeGenerated: 0,
          commissionRate: 0,
          commissionEarned: 0,
          creditExtended: 0,
          creditRepaid: 0,
          netSettlement: 0,
          activePlayers: 0,
          status: 'pending',
        };
      }
      return data;
    } catch (err: unknown) {
      console.error('[Settlement] Error calculating agent settlement:', err);
      throw err;
    }
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // PAYOUT EXECUTION
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute Monday payout cycle
   */
  async executeMondayPayouts(periodId: string): Promise<{
    agentsPaid: number;
    playersWithRakeback: number;
    totalDisbursed: number;
  }> {
    // 1. Get all approved agent settlements
    const { data: agentSettlements } = await supabase
      .from('agent_settlements')
      .select('*, agents:agent_id(user_id)')
      .eq('period_id', periodId)
      .eq('status', 'approved')
      .limit(5000);

    let agentsPaid = 0;
    let totalDisbursed = 0;

    // 2. Process each agent payout
    for (const settlement of agentSettlements || []) {
      // IDEMPOTENCY GUARD: Atomically claim this settlement by transitioning approved → processing.
      // If another instance already claimed it (0 rows affected), skip gracefully.
      const { data: claimData, error: claimError } = await supabase
        .from('agent_settlements')
        .update({ status: 'processing', updated_at: new Date().toISOString() })
        .eq('id', settlement.id)
        .eq('status', 'approved') // Only claim if still 'approved' — prevents double-pay
        .select('id');

      if (claimError || !claimData || claimData.length === 0) {
        console.error(
          `[Settlement] Skipping agent ${settlement.agent_id}: ` +
            `already claimed by another instance or status changed`
        );
        continue;
      }

      // Skip agents with zero or negative settlements (e.g. excess credit extended)
      if (settlement.net_settlement <= 0) {
        console.error(
          `[Settlement] Skipping agent ${settlement.agent_id}: ` +
            `net_settlement=${settlement.net_settlement} (non-positive)`
        );
        await supabase
          .from('agent_settlements')
          .update({
            status: 'paid',
            paid_at: new Date().toISOString(),
            notes: 'Zero/negative net — no disbursement',
          })
          .eq('id', settlement.id);
        agentsPaid++;
        continue;
      }

      try {
        const { error: payoutError } = await supabase.rpc('atomic_pay_agent_settlement', {
          p_settlement_id: settlement.id,
          p_agent_id: settlement.agent_id,
          p_amount: settlement.net_settlement,
        });

        if (payoutError) throw payoutError;

        // Resolve auth.users.id from joined agents table
        // settlement.agent_id is agents.id PK — frontend matches on auth.users.id
        const agentUserId = (settlement as any).agents?.user_id || settlement.agent_id;

        // Emit bus event so agent sees their settlement in real-time
        masterBus.emit('BALANCE_UPDATED', {
          source: 'agent_settlement_payout',
          userId: agentUserId,
        });

        // Send push notification to agent (push needs auth.users.id)
        pushNotificationService
          .notifySettlement(agentUserId, settlement.net_settlement, 'Weekly Commission')
          .catch((err) => console.error('[Settlement] Agent push failed:', err));

        agentsPaid++;
        totalDisbursed += settlement.net_settlement;
      } catch (err: unknown) {
        console.error(`[Settlement] CRITICAL: Failed to pay agent ${settlement.agent_id}:`, err);
        // Revert status to 'failed' so ops can identify and manually retry
        const errMsg = err instanceof Error ? err.message : String(err);
        await supabase
          .from('agent_settlements')
          .update({
            status: 'failed',
            error_message: errMsg,
            notes: `Payout failed or timed out: ${errMsg}`,
            updated_at: new Date().toISOString(),
          })
          .eq('id', settlement.id);

        // Raise CRITICAL financial alert for ops dashboard visibility
        try {
          const { FinancialAlertService } = await import('./FinancialAlertService');
          await FinancialAlertService.logCritical(
            'SettlementService.executeMondayPayouts',
            `Agent settlement payout STUCK in 'processing' — manual reconciliation required`,
            {
              settlementId: settlement.id,
              agentId: settlement.agent_id,
              netSettlement: settlement.net_settlement,
              periodId,
              error: errMsg,
            }
          );
        } catch (err) {
          console.error('[SettlementService] Error:', err);
          /* best effort — already logged to console */
        }

        // Emit bus event so admin dashboards show the stuck payout
        masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
          settlementId: settlement.id,
          agentId: settlement.agent_id,
          amount: settlement.net_settlement,
          periodId,
          error: errMsg,
        });
      }
    }

    // 3. Process player rakeback
    const { data: playerSnapshots } = await supabase
      .from('player_weekly_snapshots')
      .select('id, player_id, rakeback_earned, period_id')
      .eq('period_id', periodId)
      .gt('rakeback_earned', 0)
      .limit(10000);

    let playersWithRakeback = 0;
    for (const snapshot of playerSnapshots || []) {
      try {
        // Atomically pay the rakeback and mark the snapshot as paid
        const { error: payoutError } = await supabase.rpc('atomic_pay_player_rakeback', {
          p_user_id: snapshot.player_id,
          p_amount: snapshot.rakeback_earned,
        });

        if (payoutError) {
          throw payoutError;
        }

        // Emit bus event so player sees their rakeback in real-time
        masterBus.emit('BALANCE_UPDATED', {
          source: 'player_rakeback_payout',
          userId: snapshot.player_id,
        });

        // Send push notification to player
        pushNotificationService
          .notifySettlement(snapshot.player_id, snapshot.rakeback_earned, 'Weekly Rakeback')
          .catch((err) => console.error('[Settlement] Player push failed:', err));

        playersWithRakeback++;
        totalDisbursed += snapshot.rakeback_earned;
      } catch (err: unknown) {
        console.error(`Failed rakeback for player ${snapshot.player_id}:`, err);
      }
    }

    // 4. Finalize or mark partial based on payout success
    const totalExpected = (agentSettlements?.length || 0) + (playerSnapshots?.length || 0);
    const totalSucceeded = agentsPaid + playersWithRakeback;
    const successRate = totalExpected > 0 ? totalSucceeded / totalExpected : 1;

    if (totalExpected === 0 || successRate === 1) {
      // All payouts succeeded — finalize via direct update
      await supabase
        .from('settlement_periods')
        .update({ status: 'settled', settled_at: new Date().toISOString() })
        .eq('id', periodId);
    } else {
      // Partial success — mark for manual reconciliation (never auto-finalize partial)
      console.error(
        `[Settlement] Only ${totalSucceeded}/${totalExpected} payouts succeeded ` +
          `(${Math.round(successRate * 100)}%) for period ${periodId} — marking PARTIAL.`
      );
      await supabase
        .from('settlement_periods')
        .update({
          status: 'partial',
          notes: `${totalSucceeded}/${totalExpected} payouts succeeded (${Math.round(successRate * 100)}%). Manual reconciliation required.`,
        })
        .eq('id', periodId);
    }

    // 5. Emit settlement completion bus event for real-time dashboard updates
    masterBus.emit('SETTLEMENT_COMPLETED', {
      periodId,
      agentsPaid,
      playersWithRakeback,
      totalDisbursed,
      successRate: totalExpected > 0 ? totalSucceeded / totalExpected : 1,
      status: successRate === 1 ? 'settled' : 'partial',
    });

    return { agentsPaid, playersWithRakeback, totalDisbursed };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // UNION RAKE BACK — Weekly 90% Distribution
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Execute weekly union settlement: distribute 90% of collected rake back to clubs.
   * Union keeps 10% and holds ALL BBJ and Promotional chips.
   *
   * FLOW:
   * 1. Query all rake_history for this period, grouped by club
   * 2. For each club in a union: compute 90% rake back
   * 3. Credit 90% to club owner's wallet from union owner's wallet
   * 4. Log all transactions with full audit trail
   */
  async executeUnionRakeBack(
    unionId: string,
    periodStart: string,
    periodEnd: string
  ): Promise<{
    clubsPaid: number;
    totalRakeBack: number;
    unionRetained: number;
  }> {
    // Get union info
    const { data: union } = await supabase
      .from('unions')
      .select('owner_id, name')
      .eq('id', unionId)
      .maybeSingle();

    if (!union?.owner_id) throw new Error('Union not found');

    // Idempotency: Verify we haven't already paid out this union for this period
    // (This uses verify_and_log_union_rakeback to guarantee exactly-once execution)
    // First, we need to quickly sum the rake to pass to the idempotency checker
    const { data: earlyRakeData } = await supabase.rpc('get_union_rake_for_period', {
      p_union_id: unionId,
      p_start: periodStart,
      p_end: periodEnd,
    });

    // Pre-compute total rakeback from the rake query so the idempotency guard
    // records the real expected amount (prevents permanent lockout on crash).
    const estimatedTotalRake = Array.isArray(earlyRakeData)
      ? earlyRakeData.reduce((sum: number, r: any) => sum + Number(r.rake_amount || 0), 0)
      : Number(earlyRakeData?.total_rake || 0);
    const estimatedRakeBack = Math.trunc(estimatedTotalRake * 0.9 * 100) / 100;

    const { data: canExecute, error: execErr } = await supabase.rpc(
      'verify_and_log_union_rakeback',
      {
        p_union_id: unionId,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_total_rakeback: estimatedRakeBack,
      }
    );

    if (execErr) {
      console.error('[Settlement] Error verifying union idempotency:', execErr);
      throw new Error(`Execution verification failed: ${execErr.message}`);
    }

    if (canExecute === false) {
      console.error(
        `[Settlement] Union ${unionId} already had rakeback executed for ${periodStart} - ${periodEnd}. Bailing out to prevent double-payout.`
      );
      return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
    }

    // Get all clubs in this union
    const { data: clubs } = await supabase
      .from('clubs')
      .select('id, name, owner_id')
      .eq('union_id', unionId);

    if (!clubs || clubs.length === 0) return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };

    // PRE-CHECK: Verify union owner has sufficient balance for total rakeback
    // This prevents partial payouts where some clubs get paid and others don't
    const { data: unionOwnerWallet } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', union.owner_id)
      .maybeSingle();

    const unionOwnerBalance = Number(unionOwnerWallet?.balance || 0);

    // Calculate total estimated payout to all clubs
    let totalEstimatedRakeBack = 0;
    const clubRakeMap = new Map<string, number>();

    for (const club of clubs) {
      const { data: rakeData } = await supabase
        .from('rake_history')
        .select('rake_amount')
        .eq('club_id', club.id)
        .gte('collected_at', periodStart)
        .lt('collected_at', periodEnd);

      const clubRake = (rakeData || []).reduce((sum, r) => sum + Number(r.rake_amount), 0);
      const rakeBack = Math.trunc(clubRake * 0.9 * 100) / 100;
      clubRakeMap.set(club.id, rakeBack);
      totalEstimatedRakeBack += rakeBack;
    }

    // CRITICAL ALERT: Insufficient balance — abort all payouts
    if (unionOwnerBalance < totalEstimatedRakeBack) {
      const shortfall = totalEstimatedRakeBack - unionOwnerBalance;
      console.error(
        `[Settlement] CRITICAL: Union owner insufficient balance for rakeback. ` +
          `Balance: ${unionOwnerBalance}, Required: ${totalEstimatedRakeBack}, Shortfall: ${shortfall}`
      );

      try {
        const { FinancialAlertService } = await import('./FinancialAlertService');
        await FinancialAlertService.logCritical(
          'SettlementService.executeUnionRakeBack',
          `Union owner insufficient balance for rakeback distribution`,
          {
            unionId,
            unionOwnerId: union.owner_id,
            unionOwnerBalance,
            totalEstimatedRakeBack,
            shortfall,
            periodStart,
            periodEnd,
            affectedClubs: clubs.length,
          }
        );
      } catch {
        /* best effort */
      }

      masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
        type: 'union_rakeback_insufficient_balance',
        unionId,
        error: `Union owner balance insufficient. Balance: ${unionOwnerBalance}, Required: ${totalEstimatedRakeBack}, Shortfall: ${shortfall}`,
        amount: totalEstimatedRakeBack,
      });

      return { clubsPaid: 0, totalRakeBack: 0, unionRetained: 0 };
    }

    let clubsPaid = 0;
    let totalRakeBack = 0;
    let totalCollected = 0;

    for (const club of clubs) {
      const rakeBack = clubRakeMap.get(club.id) || 0;
      if (rakeBack <= 0) continue;

      // Estimate original rake from rakeback (reverse: rakeBack = rake * 0.9)
      // Use integer-cents to avoid float division by 0.9 precision loss
      const rakeBackCents = Math.trunc(rakeBack * 100);
      const clubRake = Math.trunc((rakeBackCents * 10) / 9) / 100;
      totalCollected += clubRake;

      if (rakeBack > 0 && club.owner_id) {
        // Atomic Settlement Transfer
        const { data: transferResult, error: transferError } = await retryAsync(
          () =>
            supabase.rpc('atomic_wallet_transfer', {
              p_from_user_id: union.owner_id,
              p_to_user_id: club.owner_id,
              p_amount: rakeBack,
              p_category: 'settlement',
              p_debit_description: `Weekly rake back to ${club.name}: 90% of ${clubRake}`,
              p_credit_description: `Weekly rake back from ${union.name}: 90% of ${clubRake} collected`,
              p_related_entity_id: club.id,
            }),
          3
        );

        if (transferError || transferResult === false) {
          const errMsg =
            transferError?.message || 'transferResult === false (insufficient balance?)';
          console.error(
            `[Settlement] CRITICAL: Transfer failed from Union owner to ${club.name}: ${errMsg}`
          );

          // Log critical financial alert — silent skipping is dangerous for money movement
          try {
            const { FinancialAlertService } = await import('./FinancialAlertService');
            await FinancialAlertService.logCritical(
              'SettlementService.executeUnionRakeBack',
              `Union rakeback transfer FAILED for club ${club.name} — ${rakeBack} chips not delivered. Manual reconciliation required.`,
              {
                unionId,
                clubId: club.id,
                clubName: club.name,
                clubOwnerId: club.owner_id,
                unionOwnerId: union.owner_id,
                rakeBack,
                clubRake: clubRake,
                periodStart,
                periodEnd,
                error: errMsg,
              }
            );
          } catch {
            /* best effort — already logged to console */
          }

          // Emit bus event so admin dashboards see the failure
          masterBus.emit('SETTLEMENT_PAYOUT_FAILED', {
            type: 'union_rakeback',
            unionId,
            clubId: club.id,
            clubName: club.name,
            amount: rakeBack,
            error: errMsg,
          });

          continue;
        }

        // Emit bus event so UI updates immediately
        masterBus.emit('BALANCE_UPDATED', {
          source: 'union_rakeback_deduct',
          userId: union.owner_id,
        });
        masterBus.emit('BALANCE_UPDATED', {
          source: 'union_rakeback_credit',
          userId: club.owner_id,
        });

        clubsPaid++;
        totalRakeBack += rakeBack;
      }
    }

    const unionRetained = Math.trunc((totalCollected - totalRakeBack) * 100) / 100;

    return { clubsPaid, totalRakeBack, unionRetained };
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // REPORTING
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get club settlement report
   */
  async getClubReport(clubId: string, periodId?: string): Promise<ClubSettlement | null> {
    const { data, error } = await supabase
      .from('club_settlements')
      .select(
        'id, period_id, club_id, club_name, total_rake_collected, total_jackpot_contributions, total_promo_costs, unique_players, total_hands_dealt, platform_fee, agent_commissions, gross_revenue, net_revenue, status'
      )
      .eq('club_id', await resolveClubUUID(clubId))
      .eq('period_id', periodId || (await this.getCurrentPeriod()).id)
      .maybeSingle();

    if (error) return null;
    return this.mapClubSettlement(data);
  },

  /**
   * Get agent settlement report
   */
  async getAgentReport(agentId: string, periodId?: string): Promise<AgentSettlement | null> {
    const { data, error } = await supabase
      .from('agent_settlements')
      .select(
        'id, period_id, agent_id, agent_name, total_rake_generated, commission_rate, commission_earned, total_credit_extended, total_credit_repaid, net_settlement, active_players, status'
      )
      .eq('agent_id', agentId)
      .eq('period_id', periodId || (await this.getCurrentPeriod()).id)
      .maybeSingle();

    if (error) return null;
    return this.mapAgentSettlement(data);
  },

  // ─────────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────────

  mapPeriod(p: any): SettlementPeriod {
    return {
      id: p.id,
      periodNumber: p.period_number,
      year: p.year,
      startAt: p.start_at,
      endAt: p.end_at,
      status: p.status,
      totalRakeCollected: p.total_rake_collected || 0,
      totalBBJContributions: p.total_bbj_contributions || 0,
      totalPlayerWinnings: p.total_player_winnings || 0,
      totalPlayerLosses: p.total_player_losses || 0,
      totalHandsDealt: p.total_hands_dealt || 0,
      settledAt: p.settled_at,
      settledBy: p.settled_by,
    };
  },

  mapClubSettlement(s: any): ClubSettlement {
    return {
      id: s.id,
      periodId: s.period_id,
      clubId: s.club_id,
      clubName: s.club_name || 'Unknown Club',
      totalRakeCollected: s.total_rake_collected,
      totalJackpotContributions: s.total_jackpot_contributions,
      totalPromoCosts: s.total_promo_costs,
      uniquePlayers: s.unique_players,
      totalHandsDealt: s.total_hands_dealt,
      platformFee: s.platform_fee,
      agentCommissions: s.agent_commissions,
      grossRevenue: s.gross_revenue,
      netRevenue: s.net_revenue,
      status: s.status,
    };
  },

  mapAgentSettlement(s: any): AgentSettlement {
    return {
      id: s.id,
      periodId: s.period_id,
      agentId: s.agent_id,
      agentName: s.agent_name || 'Unknown Agent',
      totalRakeGenerated: s.total_rake_generated,
      commissionRate: s.commission_rate,
      commissionEarned: s.commission_earned,
      creditExtended: s.total_credit_extended || 0,
      creditRepaid: s.total_credit_repaid || 0,
      netSettlement: s.net_settlement,
      activePlayers: s.active_players || 0,
      status: s.status,
    };
  },
};

export default SettlementService;
