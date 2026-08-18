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
import { reportError } from '../utils/errorReporter';

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
    } catch (err) {
      reportError(err, 'ThrowableService.Error');
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
      // ── Atomic server path (2026-08-17) ──────────────────────────────────
      // fn_use_throwable serialises the free-allowance check per user
      // (advisory xact lock) and does charge+record in ONE transaction,
      // closing two defects of the old client flow: a two-tab race that
      // could double-spend the last free throw, and a paid path where a
      // failure between deduct_diamonds and the usage insert charged a
      // diamond and recorded nothing. Allowance and price are
      // server-authoritative there.
      const { data: atomic, error: atomicErr } = await supabase.rpc('fn_use_throwable', {
        p_throwable_id: throwableId,
      });
      if (!atomicErr && atomic) {
        if ((atomic as any).success === true) return { success: true };
        return { success: false, error: (atomic as any).error || 'Throw failed' };
      }
      // The legacy client-side fallback that used to live here is GONE.
      //
      // It called deduct_diamonds(p_user_id, p_amount, ...) straight from the
      // browser, and was the only reason `authenticated` still held EXECUTE on
      // that RPC. deduct_diamonds does self-check auth.uid() = p_user_id, so it
      // could never drain another player - but a browser could still bypass the
      // /api/diamonds/spend ALLOWED_SOURCES validation to write arbitrary
      // source/type/description rows into diamond_transactions, and replay a
      // known p_reference_id to get {success:true, idempotent:true} back with
      // no new deduction.
      //
      // The fallback was also wrong on its own terms: it checked only
      // `deductError` and never the returned `success` flag, and an
      // insufficient-funds result comes back as data.success=false with NO
      // postgres error - so it fell through and recorded a free throw.
      //
      // Safe to delete outright: fn_use_throwable is live in production
      // (SECURITY DEFINER, derives the user from auth.uid(), takes no user_id
      // or amount parameter, advisory-locked), and diamond_transactions holds
      // 0 rows with transaction_type='throwable' all-time - this paid path
      // never once charged a real player. Keeping it would also have left a
      // path that cannot work at all once the EXECUTE grant is revoked.
      if (atomicErr) {
        reportError(atomicErr, 'ThrowableService.fn_use_throwable_failed');
      }
      return { success: false, error: 'Throw unavailable, please try again' };
    } catch (err) {
      reportError(err, 'ThrowableService.Error');
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
