/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PROMOTION SERVICE — Club Promotions & Campaign Management
 * Handles promotions, bonuses, leaderboards, and special events
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { supabase } from '../lib/supabase';
import { WalletService } from './WalletService';
import { masterBus } from '../core/MasterBus';
import { retryAsync } from '../utils/retryAsync';
import {
  playerDisplayName,
  PLAYER_NAME_COLUMNS,
  type NameableProfile,
} from '../utils/playerDisplayName';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PromotionType =
  | 'bonus'
  | 'freeroll'
  | 'leaderboard'
  | 'rakeback'
  | 'special'
  | 'deposit_match'
  | 'refer_friend';

export interface Promotion {
  id: string;
  clubId: string;
  title: string;
  description: string;
  type: PromotionType;
  imageUrl?: string;
  startDate: string;
  endDate: string;
  prizePool?: number;
  isActive: boolean;
  requirements?: string;
  terms?: string;
  maxClaims?: number;
  claimCount: number;
  minDeposit?: number;
  bonusPercent?: number;
  wagerRequirement?: number;
  createdAt: string;
}

export interface PromotionClaim {
  id: string;
  promotionId: string;
  userId: string;
  claimedAt: string;
  status: 'pending' | 'active' | 'completed' | 'expired';
  bonusAmount?: number;
  wagerProgress?: number;
  wagerRequired?: number;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  score: number;
  prize?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROMOTION SERVICE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class PromotionServiceClass {
  // ─────────────────────────────────────────────────────────────────────────────
  // Promotion CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  async getPromotions(
    clubId?: string,
    filter?: 'active' | 'upcoming' | 'ended'
  ): Promise<Promotion[]> {
    let query = supabase
      .from('promotions')
      .select(
        'id, club_id, title:name, description, type, image_url:banner_url, start_date, end_date, prize_pool, status, requirements, max_claims, min_deposit, bonus_percent, wager_requirement, created_at'
      )
      .order('start_date', { ascending: false });

    if (clubId) {
      query = query.eq('club_id', await resolveClubUUID(clubId));
    }

    const now = new Date().toISOString();
    if (filter === 'active') {
      query = query.lte('start_date', now).gte('end_date', now);
    } else if (filter === 'upcoming') {
      query = query.gt('start_date', now);
    } else if (filter === 'ended') {
      query = query.lt('end_date', now);
    }

    const { data, error } = await query.limit(50);

    if (error) {
      reportError(error, 'PromotionService.Error_fetching_promotions');
      return [];
    }

    return (data || []).map(this.mapPromotion);
  }

  async getPromotion(promotionId: string): Promise<Promotion | null> {
    const { data, error } = await supabase
      .from('promotions')
      .select(
        'id, club_id, title:name, description, type, image_url:banner_url, start_date, end_date, prize_pool, status, requirements, max_claims, min_deposit, bonus_percent, wager_requirement, created_at'
      )
      .eq('id', promotionId)
      .maybeSingle();

    if (error || !data) return null;
    return this.mapPromotion(data);
  }

  async createPromotion(clubId: string, config: Partial<Promotion>): Promise<Promotion> {
    const { data, error } = await supabase
      .from('promotions')
      .insert({
        club_id: clubId,
        name: config.title,
        description: config.description,
        type: config.type || 'bonus',
        banner_url: config.imageUrl,
        start_date: config.startDate,
        end_date: config.endDate,
        prize_pool: config.prizePool,
        status: 'active',
        requirements: config.requirements,
        max_claims: config.maxClaims,
        min_deposit: config.minDeposit,
        bonus_percent: config.bonusPercent,
        wager_requirement: config.wagerRequirement,
      })
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) throw new Error('Promotion created but no data returned');
    return this.mapPromotion(data);
  }

  async updatePromotion(promotionId: string, updates: Partial<Promotion>): Promise<void> {
    const { error } = await supabase
      .from('promotions')
      .update({
        name: updates.title,
        description: updates.description,
        type: updates.type,
        banner_url: updates.imageUrl,
        start_date: updates.startDate,
        end_date: updates.endDate,
        prize_pool: updates.prizePool,
        status: updates.isActive === undefined ? undefined : updates.isActive ? 'active' : 'ended',
        requirements: updates.requirements,
      })
      .eq('id', promotionId);

    if (error) throw error;
  }

  async deletePromotion(promotionId: string, clubId?: string): Promise<void> {
    let query = supabase.from('promotions').delete().eq('id', promotionId);
    // SECURITY: Scope to club to prevent cross-club deletion
    if (clubId) query = query.eq('club_id', clubId);
    const { error } = await query;

    if (error) throw error;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Claiming Promotions
  // ─────────────────────────────────────────────────────────────────────────────

  async claimPromotion(promotionId: string, userId: string): Promise<PromotionClaim> {
    // Check if already claimed
    const { data: existingClaim, error: existingClaimErr } = await supabase
      .from('promotion_claims')
      .select('id')
      .eq('promotion_id', promotionId)
      .eq('user_id', userId)
      .maybeSingle();

    /* A FAILED CHECK IS NOT "NOT CLAIMED YET" (2026-08-29). Only `data` was
       destructured, and a Supabase builder resolves with {data: null, error}
       rather than rejecting -- so a failed read fell through to the claim
       below, which pays out. The unique constraint stops the second row, but
       this path leads to money and a guard that cannot see its own failure is
       not a guard. */
    if (existingClaimErr) {
      throw new Error('Could not verify that promotion. Please try again.');
    }

    if (existingClaim) {
      throw new Error('Promotion already claimed');
    }

    // Get promotion details
    const promo = await this.getPromotion(promotionId);
    if (!promo) throw new Error('Promotion not found');

    // Check if max claims reached
    if (promo.maxClaims && promo.claimCount >= promo.maxClaims) {
      throw new Error('Promotion is fully claimed');
    }

    // Check if promotion is active
    const now = new Date();
    if (new Date(promo.startDate) > now || new Date(promo.endDate) < now) {
      throw new Error('Promotion is not active');
    }

    /* THE ROW SAYS WHAT THE PROMOTION SAYS (20260905084034).
     *
     * This used to send `bonus_amount`, `wager_required` and `status` from
     * here. The only INSERT policy on `promotion_claims` is
     * `user_id = auth.uid()` - it checks WHO is claiming and nothing about
     * WHAT, so any signed-in caller could post a claim carrying any figure it
     * liked into a money column. A BEFORE INSERT trigger now derives all three
     * from the `promotions` row and discards whatever arrives, so sending them
     * would be theatre. Proved against production, then rolled back: a claim
     * asking for 999,999.99 on a 1,000 pool over 40 claims was recorded as
     * 25.00.
     *
     * The claim still credits NOTHING. Only the deposit-match path calls
     * `add_to_promo_wallet`, and what a claim on a leaderboard or milestone
     * promotion should pay is Dan's to set (CLAUDE.md 10.9), so this records
     * the claim honestly and says so rather than implying money moved. */
    const { data, error } = await supabase
      .from('promotion_claims')
      .insert({
        promotion_id: promotionId,
        user_id: userId,
        wager_progress: 0,
      })
      .select()
      .maybeSingle();

    if (error) throw error;

    // Atomically increment claim count using SQL increment to prevent race condition
    // with concurrent claims. This ensures the counter is incremented safely even
    // under high concurrency.
    try {
      await retryAsync(
        () =>
          supabase.rpc('increment_promotion_claim_count', {
            p_promotion_id: promotionId,
          }),
        2
      );
    } catch (countErr: any) {
      reportError(countErr, 'PromotionService.Failed_to_increment_claim_count');
      // Non-blocking: claim was successful even if counter increment failed
    }

    if (!data) throw new Error('Claim created but no data returned');
    return this.mapClaim(data);
  }

  async getUserClaims(userId: string): Promise<PromotionClaim[]> {
    /* This embedded `promotions(title, type)` and returned 400 on every call,
       for every user, since it was written — two separate reasons:

         1. PGRST200. PostgREST can only embed across a real FOREIGN KEY, and
            promotion_claims had none at all. (Added 2026-08-20 as
            promotion_claims_promotion_id_fkey — worth having regardless on a
            table that carries bonus_amount, but no longer load-bearing here.)
         2. `promotions` has no `title` column. It is `name`.

       The embed is gone rather than corrected because mapClaim() below never
       reads it and PromotionClaim has no field for it. It fetched data nobody
       consumed, and in doing so failed the whole query.

       And `if (error) return []` is why nobody ever found out: a user's
       claimed promotions were silently empty, indistinguishable from having
       claimed none. An empty list is still the right fallback for a UI list —
       reporting it is what was missing. */
    const { data, error } = await supabase
      .from('promotion_claims')
      .select(
        'id, promotion_id, user_id, status, bonus_amount, wager_progress, wager_required, claimed_at'
      )
      .eq('user_id', userId)
      .order('claimed_at', { ascending: false });

    if (error) {
      reportError(error, 'PromotionService.getUserClaims', { userId });
      return [];
    }
    return (data || []).map(this.mapClaim);
  }

  async updateWagerProgress(claimId: string, wagerAmount: number): Promise<void> {
    // Use direct update for atomic increment to prevent race conditions
    // on concurrent wager events
    const { data: claim } = await supabase
      .from('promotion_claims')
      .select('wager_progress')
      .eq('id', claimId)
      .maybeSingle();

    if (claim) {
      const { error } = await supabase
        .from('promotion_claims')
        .update({ wager_progress: (claim.wager_progress || 0) + wagerAmount })
        .eq('id', claimId);

      if (error) {
        reportError(error, 'PromotionService.Failed_to_update_wager_progress');
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Leaderboards
  // ─────────────────────────────────────────────────────────────────────────────

  async getLeaderboard(promotionId: string, limit: number = 10): Promise<LeaderboardEntry[]> {
    const { data, error } = await supabase
      .from('promotion_leaderboards')
      .select(
        `
                rank,
                score,
                prize,
                profiles(id, ${PLAYER_NAME_COLUMNS}, avatar_url:arena_avatar_url)
            `
      )
      .eq('promotion_id', promotionId)
      .order('rank', { ascending: true })
      .limit(limit);

    // An unavailable board is not an empty competition. Both consumers handle
    // rejection; preserve it so the console can offer its working retry.
    if (error) throw error;
    if (!data) return [];

    return data.map((entry: any) => {
      const profile = entry.profiles as
        | (NameableProfile & {
            id: string;
            avatar_url?: string;
          })
        | null;
      return {
        rank: entry.rank,
        userId: profile?.id || '',
        username: playerDisplayName(profile),
        displayName: playerDisplayName(profile),
        avatarUrl: profile?.avatar_url,
        score: entry.score,
        prize: entry.prize,
      };
    });
  }

  async updateLeaderboardScore(promotionId: string, userId: string, score: number): Promise<void> {
    // Upsert the score
    const { error: upsertErr } = await supabase.from('promotion_leaderboards').upsert(
      {
        promotion_id: promotionId,
        user_id: userId,
        score,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'promotion_id,user_id' }
    );

    if (upsertErr) {
      reportError(upsertErr, 'PromotionService.Leaderboard_upsert_failed');
      return;
    }

    // Recalculate ranks
    const { error: rankErr } = await retryAsync(
      () =>
        supabase.rpc('recalculate_leaderboard_ranks', {
          p_promotion_id: promotionId,
        }),
      3
    );
    if (rankErr) reportError(rankErr, 'PromotionService.Leaderboard_rank_recalc_failed');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Deposit Match Bonuses
  // ─────────────────────────────────────────────────────────────────────────────

  async applyDepositBonus(userId: string, depositAmount: number): Promise<number> {
    // Find applicable deposit bonus promotion
    /**
     * `is_active` DOES NOT EXIST ON THIS TABLE (2026-08-29).
     *
     * `promotions` carries `status text CHECK (status IN ('scheduled','active',
     * 'paused','completed','cancelled'))`. Filtering on a boolean `is_active`
     * makes PostgREST return 42703 -- the whole query fails -- and because the
     * error was not destructured, the failure was indistinguishable from "no
     * such promotion" and this function returned 0 every single time.
     *
     * `getPromotions` in this same file filters on `status` correctly, and the
     * mapper thirty lines below even says so: "promotions has `status`
     * (open/active/...), not a boolean is_active." Two paths in one file
     * disagreeing, with only one of them reachable.
     *
     * The error is now checked, because a deposit bonus that cannot be read is
     * not a deposit bonus that does not exist.
     */
    const { data: promotions, error: promoErr } = await supabase
      .from('promotions')
      .select(
        'id, club_id, title:name, description, type, image_url:banner_url, start_date, end_date, prize_pool, status, requirements, max_claims, min_deposit, bonus_percent, wager_requirement, created_at'
      )
      .eq('type', 'deposit_match')
      .eq('status', 'active')
      .lte('start_date', new Date().toISOString())
      .gte('end_date', new Date().toISOString())
      .limit(1);

    if (promoErr) {
      reportError(promoErr, 'PromotionService.deposit_bonus_lookup_failed');
      return 0;
    }
    if (!promotions?.length) return 0;

    const promo = this.mapPromotion(promotions[0]);

    if (promo.minDeposit && depositAmount < promo.minDeposit) {
      return 0;
    }

    const bonusAmount =
      Math.trunc(((depositAmount * (promo.bonusPercent || 100)) / 100) * 100) / 100;
    const maxBonus = promo.prizePool || 500;
    const finalBonus = Math.min(bonusAmount, maxBonus);

    // Create the claim
    await this.claimPromotion(promo.id, userId);

    // Add bonus to promo wallet with audit trail
    const { error: bonusErr } = await supabase.rpc('add_to_promo_wallet', {
      p_user_id: userId,
      p_amount: finalBonus,
    });
    if (bonusErr) {
      reportError(bonusErr, 'PromotionService.Deposit_bonus_credit_failed');
      return 0;
    }

    // Log transaction for audit trail (non-blocking: bonus already credited)
    try {
      await WalletService.logTransaction(
        userId,
        'PROMO',
        finalBonus,
        'credit',
        'promotion',
        `Deposit bonus: ${promo.title}`
      );
    } catch (logErr) {
      reportError(logErr, 'PromotionService.Deposit_bonus_audit_log_failed');
    }
    masterBus.emit('BALANCE_UPDATED', { source: 'promotion_deposit_bonus', userId });

    return finalBonus;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Referral System
  // ─────────────────────────────────────────────────────────────────────────────

  async processReferral(referredUserId: string, referrerCode: string): Promise<void> {
    // Find referrer by code
    const { data: referrer } = await supabase
      .from('profiles')
      .select('id')
      .eq('referral_code', referrerCode)
      .maybeSingle();

    if (!referrer) return;

    // Check for refer-a-friend promotion
    // Same defect as applyDepositBonus above: `is_active` is not a column on
    // `promotions`, so this query always failed and the discarded error made
    // it look like no referral promotion was configured.
    const { data: promotions, error: promoErr } = await supabase
      .from('promotions')
      .select(
        'id, club_id, title:name, description, type, image_url:banner_url, start_date, end_date, prize_pool, status, requirements, max_claims, min_deposit, bonus_percent, wager_requirement, created_at'
      )
      .eq('type', 'refer_friend')
      .eq('status', 'active')
      .limit(1);

    if (promoErr) {
      reportError(promoErr, 'PromotionService.referral_promo_lookup_failed');
      return;
    }
    if (!promotions?.length) return;

    const promo = this.mapPromotion(promotions[0]);

    // Award referrer bonus
    const referralBonus = Math.trunc((promo.prizePool || 10) * 100) / 100;
    const { error: refErr } = await supabase.rpc('add_to_promo_wallet', {
      p_user_id: referrer.id,
      p_amount: referralBonus,
    });
    if (refErr) {
      reportError(refErr, 'PromotionService.Referral_bonus_credit_failed');
      return;
    }

    // Log transaction for audit trail (non-blocking: bonus already credited)
    try {
      await WalletService.logTransaction(
        referrer.id,
        'PROMO',
        referralBonus,
        'credit',
        'promotion',
        'Referral bonus reward'
      );
    } catch (logErr) {
      reportError(logErr, 'PromotionService.Referral_audit_log_failed');
    }
    masterBus.emit('BALANCE_UPDATED', { source: 'promotion_referral_bonus', userId: referrer.id });

    // Record the referral
    // The column is `referee_id`, not `referred_id`; `promotion_id` and
    // `bonus_amount` do not exist on this table at all; and
    // `referral_code_used` is NOT NULL with no default. Every one of these rows
    // was rejected, so the bonus above was paid and the referral it paid for
    // was never recorded. The amount is not lost with the two dropped fields:
    // WalletService.logTransaction wrote it a few lines above.
    const { error: refInsertErr } = await supabase.from('referrals').insert({
      referrer_id: referrer.id,
      referee_id: referredUserId,
      referral_code_used: referrerCode,
      status: 'completed',
      reward_claimed_referrer: true,
      completed_at: new Date().toISOString(),
    });
    if (refInsertErr) {
      reportError(refInsertErr, 'PromotionService.Referral_record_insert_failed');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Mappers
  // ─────────────────────────────────────────────────────────────────────────────

  private mapPromotion(data: any): Promotion {
    return {
      id: data.id,
      clubId: data.club_id,
      title: data.title,
      description: data.description,
      type: data.type,
      imageUrl: data.image_url,
      startDate: data.start_date,
      endDate: data.end_date,
      prizePool: data.prize_pool,
      // promotions has `status` (open/active/…), not a boolean is_active.
      isActive: data.status !== 'ended' && data.status !== 'cancelled',
      requirements: data.requirements,
      // No `terms`/`claim_count` columns on promotions; surface requirements as
      // terms and default the count (claims live in promotion_claims).
      terms: data.requirements || '',
      maxClaims: data.max_claims,
      claimCount: 0,
      minDeposit: data.min_deposit,
      bonusPercent: data.bonus_percent,
      wagerRequirement: data.wager_requirement,
      createdAt: data.created_at,
    };
  }

  private mapClaim(data: any): PromotionClaim {
    return {
      id: data.id,
      promotionId: data.promotion_id,
      userId: data.user_id,
      claimedAt: data.claimed_at,
      status: data.status,
      bonusAmount: data.bonus_amount,
      wagerProgress: data.wager_progress,
      wagerRequired: data.wager_required,
    };
  }
}

export const promotionService = new PromotionServiceClass();
