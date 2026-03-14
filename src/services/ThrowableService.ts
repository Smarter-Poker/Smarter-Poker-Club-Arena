/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THROWABLE SERVICE — Emotes & Animations
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Poker Bros / PokerStars style throwables:
 * - VIP: 500 free throws per month, then 1 Diamond each
 * - Non-VIP: 1 Diamond per throw
 */

import { supabase } from '../lib/supabase';
import { retryAsync } from '../utils/retryAsync';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type ThrowableCategory = 'reactions' | 'throws' | 'cheers' | 'expressions' | 'premium';

export interface Throwable {
  id: string;
  name: string;
  category: ThrowableCategory;
}

export interface ThrowEvent {
  id: string;
  fromSeat: number;
  toSeat: number;
  throwableId: string;
  throwable: Throwable;
  timestamp: number;
}

export interface ThrowAllowance {
  isVip: boolean;
  freeThrowsRemaining: number;
  diamondCost: number; // 0 if free throws available, otherwise 1
}

// ═══════════════════════════════════════════════════════════════════════════════
// THROWABLE LIBRARY (25 Items) — All 2 Diamonds or Free for VIP
// ═══════════════════════════════════════════════════════════════════════════════

const THROWABLES: Throwable[] = [
  // ── REACTIONS ─────────────────────────────────────────────────────────────────
  { id: 'thumbs-up', name: 'Thumbs Up', category: 'reactions' },
  { id: 'clap', name: 'Applause', category: 'reactions' },
  { id: 'lol', name: 'LOL', category: 'reactions' },
  { id: 'sad', name: 'Sad', category: 'reactions' },
  { id: 'mad', name: 'Mad', category: 'reactions' },

  // ── THROWS ────────────────────────────────────────────────────────────────────
  { id: 'tomato', name: 'Tomato', category: 'throws' },
  { id: 'egg', name: 'Egg', category: 'throws' },
  { id: 'snowball', name: 'Snowball', category: 'throws' },
  { id: 'water-balloon', name: 'Water Balloon', category: 'throws' },
  { id: 'pie', name: 'Pie', category: 'throws' },

  // ── CHEERS ────────────────────────────────────────────────────────────────────
  { id: 'beer', name: 'Beer', category: 'cheers' },
  { id: 'champagne', name: 'Champagne', category: 'cheers' },
  { id: 'trophy', name: 'Trophy', category: 'cheers' },
  { id: 'fireworks', name: 'Fireworks', category: 'cheers' },
  { id: 'confetti', name: 'Confetti', category: 'cheers' },

  // ── EXPRESSIONS ───────────────────────────────────────────────────────────────
  { id: 'good-luck', name: 'Good Luck', category: 'expressions' },
  { id: 'nice-hand', name: 'Nice Hand', category: 'expressions' },
  { id: 'fish', name: 'Fish', category: 'expressions' },
  { id: 'shark', name: 'Shark', category: 'expressions' },
  { id: 'all-in', name: 'All-In!', category: 'expressions' },

  // ── PREMIUM ───────────────────────────────────────────────────────────────────
  { id: 'diamond-rain', name: 'Diamond Rain', category: 'premium' },
  { id: 'dragon', name: 'Dragon', category: 'premium' },
  { id: 'lightning', name: 'Lightning', category: 'premium' },
  { id: 'tsunami', name: 'Tsunami', category: 'premium' },
  { id: 'crown', name: 'Crown', category: 'premium' },
];

const VIP_FREE_THROWS_PER_MONTH = 500;
const DIAMOND_COST_PER_THROW = 1;

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

class ThrowableServiceClass {
  /**
   * Get all throwables
   */
  getThrowables(): Throwable[] {
    return THROWABLES;
  }

  /**
   * Get throwables grouped by category
   */
  getThrowablesByCategory(): Record<ThrowableCategory, Throwable[]> {
    return {
      reactions: THROWABLES.filter((t) => t.category === 'reactions'),
      throws: THROWABLES.filter((t) => t.category === 'throws'),
      cheers: THROWABLES.filter((t) => t.category === 'cheers'),
      expressions: THROWABLES.filter((t) => t.category === 'expressions'),
      premium: THROWABLES.filter((t) => t.category === 'premium'),
    };
  }

  /**
   * Check user's throw allowance (VIP gets 500 free/month)
   */
  async getThrowAllowance(userId: string): Promise<ThrowAllowance> {
    try {
      // Check if user has VIP
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_vip')
        .eq('id', userId)
        .maybeSingle();

      const isVip = profile?.is_vip || false;

      if (!isVip) {
        return { isVip: false, freeThrowsRemaining: 0, diamondCost: DIAMOND_COST_PER_THROW };
      }

      // Get this month's usage for VIP
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);

      const { count } = await supabase
        .from('throw_usage')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart.toISOString());

      const used = count || 0;
      const remaining = Math.max(0, VIP_FREE_THROWS_PER_MONTH - used);

      return {
        isVip: true,
        freeThrowsRemaining: remaining,
        diamondCost: remaining > 0 ? 0 : DIAMOND_COST_PER_THROW,
      };
    } catch {
      return { isVip: false, freeThrowsRemaining: 0, diamondCost: DIAMOND_COST_PER_THROW };
    }
  }

  /**
   * Use a throwable (deduct from allowance or charge diamonds)
   */
  async useThrowable(
    userId: string,
    throwableId: string
  ): Promise<{ success: boolean; error?: string }> {
    const throwable = THROWABLES.find((t) => t.id === throwableId);
    if (!throwable) {
      return { success: false, error: 'Throwable not found' };
    }

    try {
      const allowance = await this.getThrowAllowance(userId);

      // If VIP with free throws remaining, just record usage
      if (allowance.isVip && allowance.freeThrowsRemaining > 0) {
        const { error: usageErr } = await supabase
          .from('throw_usage')
          .insert({ user_id: userId, throwable_id: throwableId });
        if (usageErr) {
          console.error('[ThrowableService] Failed to record VIP throw usage:', usageErr);
          return { success: false, error: 'Failed to record throw usage' };
        }
        return { success: true };
      }

      // Otherwise charge 1 diamond
      const { data: profile } = await supabase
        .from('profiles')
        .select('diamonds')
        .eq('id', userId)
        .maybeSingle();

      if (!profile || (profile.diamonds || 0) < DIAMOND_COST_PER_THROW) {
        return { success: false, error: `Need ${DIAMOND_COST_PER_THROW} Diamonds` };
      }

      // Deduct diamonds atomically via RPC
      const { error: deductError } = await retryAsync(
        () =>
          supabase.rpc('deduct_diamonds', {
            p_user_id: userId,
            p_amount: DIAMOND_COST_PER_THROW,
            p_description: `Throwable: ${throwable.name}`,
            p_transaction_type: 'throwable',
          }),
        3
      );

      if (deductError) {
        return { success: false, error: 'Failed to deduct diamonds' };
      }

      // Record usage
      const { error: usageErr2 } = await supabase
        .from('throw_usage')
        .insert({ user_id: userId, throwable_id: throwableId, paid_diamonds: true });
      if (usageErr2) console.error('[ThrowableService] Paid throw usage record failed:', usageErr2);

      return { success: true };
    } catch {
      return { success: false, error: 'Unexpected error' };
    }
  }

  /**
   * Create throw event for WebSocket broadcast
   */
  createThrowEvent(fromSeat: number, toSeat: number, throwableId: string): ThrowEvent | null {
    const throwable = THROWABLES.find((t) => t.id === throwableId);
    if (!throwable) return null;

    return {
      id: crypto.randomUUID(),
      fromSeat,
      toSeat,
      throwableId,
      throwable,
      timestamp: Date.now(),
    };
  }

  /**
   * Get a single throwable by ID
   */
  getThrowableById(id: string): Throwable | null {
    return THROWABLES.find((t) => t.id === id) || null;
  }
}

export const throwableService = new ThrowableServiceClass();
export default throwableService;
