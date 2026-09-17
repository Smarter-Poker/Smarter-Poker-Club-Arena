/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DAILY BONUS SERVICE - the Daily Club Arena Bonus sheet's only door
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two RPCs, both server-authoritative (docs/DAILY-CLUB-ARENA-BONUS.md):
 *
 *   fn_ca_daily_bonus_status()                 what today offers and what is claimed
 *   fn_ca_daily_bonus_claim(slot, req, day)    pay one tile, exactly once
 *   fn_ca_daily_bonus_mark_shown()             today's sheet was shown (one popup per day, any device)
 *
 * The claim names the day the sheet showed (`p_bonus_date`). A tap that lands
 * after Chicago midnight is refused with `day_rolled_over` and the sheet
 * re-reads, rather than the server paying slot N of a day the player never
 * saw (20260909203926).
 *
 * The client never sends an amount and never credits anything itself. A tile
 * pays diamonds through award_diamonds_v2 or a consumable credit in
 * feature_purchases, inside the claim function, under the per-player caps.
 * Nothing here can mint: the only thing the browser decides is WHICH tile,
 * and the server refuses a tile that is not today's, is already claimed, or
 * is VIP-only for a non-VIP.
 *
 * REQUEST IDS. Each (day, slot) gets one uuid that is remembered for the day
 * (sessionStorage, best effort), so a retry after a dropped response replays
 * the server's stored result instead of paying twice. The server keys its
 * replay on (user, request_id), so even a fresh uuid could only ever be
 * refused with `already_claimed` - the id is for a clean retry, not for
 * safety.
 */

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { reportError } from '../utils/errorReporter';
import { DailyBonusStatusError } from './dailyBonusStatusError';

/**
 * Phase 3 (20260910181625): a `shield` tile is a Streak Shield credit, a
 * `boost` tile is 24 hours of 2x diamonds on Daily Missions, and a mystery
 * tile's prize is multiplied by a lucky roll the server makes at the tap.
 */
export type DailyBonusTileKind =
  | 'diamonds'
  | 'throwables'
  | 'rabbit_hunts'
  | 'time_bank'
  | 'mystery'
  | 'shield'
  | 'boost'
  | 'free_spin';

export interface DailyBonusGranted {
  kind: Exclude<DailyBonusTileKind, 'mystery'>;
  diamonds: number;
  quantity: number;
  feature?: string;
  feature_purchase_id?: string;
  diamond_transaction_id?: string;
  expires_at?: string;
  balance_after: number | null;
  /** Mystery tiles only: the server's lucky multiplier (1-5) already applied to the amounts. */
  lucky?: number;
  /** Boost only. */
  factor?: number;
  hours?: number;
  boost_id?: string;
  ends_at?: string;
  /** Claimed tenth-day spin. This is a ticket, not spendable diamonds. */
  ticket_id?: string;
  entry_diamonds?: number;
  funded_by?: 'mint';
}

/** What a claimed mystery tile turned out to be, lucky roll applied. */
export interface DailyBonusRevealed {
  kind: DailyBonusTileKind;
  diamonds: number;
  quantity: number;
  lucky?: number;
}

export interface DailyBonusShield {
  /** Unspent, unexpired shields the player holds. */
  held: number;
  expires_at: string | null;
}

export interface DailyBonusBoost {
  active: boolean;
  factor?: number;
  kind?: string;
  ends_at?: string;
  seconds_left?: number;
  applied_diamonds?: number;
}

export interface DailyBonusTile {
  slot: number;
  kind: DailyBonusTileKind;
  label: string;
  vip_only: boolean;
  quantity: number;
  base_diamonds: number;
  /** Diamonds this tile pays today, streak multiplier applied, clamped by the server. */
  diamonds: number;
  claimed: boolean;
  claimed_at: string | null;
  granted: DailyBonusGranted | null;
  /** VIP tile shown to a non-VIP. */
  locked: boolean;
  /** A diamond tile the player's remaining daily cap would trim. */
  capped: boolean;
  /** A claimed mystery tile: what it turned out to be. */
  revealed?: DailyBonusRevealed | null;
}

export interface DailyBonusWeekDay {
  day: number;
  streak: number;
  diamonds: number | null;
  extras: string | null;
  /** Today's entry on a chest day (streak 14, 30): the strip shows the chest, not the cycle row. */
  chest?: boolean;
  state: 'done' | 'today' | 'upcoming';
}

export interface DailyBonusPreview {
  kind: DailyBonusTileKind;
  label: string;
  vip_only: boolean;
  quantity: number;
  diamonds: number;
}

export interface DailyBonusCaps {
  daily_cap: number;
  daily_used: number;
  daily_remaining: number;
  monthly_cap: number;
  monthly_used: number;
  monthly_remaining: number;
  bonus_monthly_cap: number;
  bonus_monthly_used: number;
  bonus_monthly_remaining: number;
  frozen: boolean;
}

export interface DailyBonusStatus {
  eligible: boolean;
  reason?: string;
  today: string;
  reset_at: string;
  seconds_to_reset: number;
  streak: number;
  cycle_day: number;
  streak_day: number | null;
  multiplier: number;
  is_vip: boolean;
  claimed_today: boolean;
  /** The sheet has already been put in front of this player today, on any device (one popup per day). */
  shown_today: boolean;
  unclaimed: number;
  tiles: DailyBonusTile[];
  week: DailyBonusWeekDay[];
  tomorrow: DailyBonusPreview[];
  caps: DailyBonusCaps | null;
  cents_per_diamond: number;
  /** Phase 3: shields held, a live Mission Boost, and whether a shield saved today's streak. */
  shield: DailyBonusShield;
  boost: DailyBonusBoost;
  streak_protected: boolean;
  bonus_spin_every_days?: number;
  bonus_spin_entry_diamonds?: number;
  bonus_spins_held?: number;
}

export interface DailyBonusClaimResult {
  success: boolean;
  reason?: string;
  idempotent?: boolean;
  slot?: number;
  /** The Chicago day the claim was paid on (success) or the server's today (day_rolled_over). */
  bonus_date?: string;
  today?: string;
  granted?: DailyBonusGranted;
  revealed?: DailyBonusRevealed | null;
  streak?: number;
  first_claim_of_day?: boolean;
  detail?: unknown;
}

/** Player-facing text for a server refusal. An unknown reason reads as itself. */
export const CLAIM_REASON_TEXT: Record<string, string> = {
  already_claimed: 'Already Claimed Today',
  no_such_tile: 'That Tile Is Not On Today’s Sheet',
  vip_only: 'VIP Members Only',
  nothing_to_pay: 'Nothing To Pay On This Tile',
  daily_cap: 'Daily Diamond Cap Reached',
  monthly_cap: 'Monthly Diamond Cap Reached',
  action_limit: 'Daily Bonus Limit Reached',
  budget_exhausted: 'Rewards Are Paused Right Now',
  diamond_issuance_frozen: 'Rewards Are Paused Right Now',
  duplicate: 'Already Claimed Today',
  fixture: 'Not Available On This Account',
  horse: 'Not Available On This Account',
  unauthenticated: 'Sign In To Claim',
  no_profile: 'Sign In To Claim',
  request_id_required: 'Could Not Claim, Try Again',
  day_rolled_over: 'A New Day Has Started, Here Is Today’s Sheet',
  boost_already_live: 'A Mission Boost Is Already Running',
  invalid_amount: 'Nothing To Pay On This Tile',
  award_refused: 'Could Not Claim, Try Again',
  empty_response: 'Could Not Claim, Try Again',
  transport: 'Could Not Claim, Try Again',
};

export function claimReasonText(reason: string | undefined): string {
  if (!reason) return 'Could Not Claim, Try Again';
  return CLAIM_REASON_TEXT[reason] ?? `Could Not Claim (${reason})`;
}

const REQUEST_KEY_PREFIX = 'ca_daily_bonus_req:';

function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // RFC 4122 v4 fallback for very old WebViews; the server only needs a uuid shape.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

class DailyBonusServiceClass {
  private requestIds = new Map<string, string>();

  /** One request id per (day, slot), remembered for the session so a retry replays. */
  requestIdFor(today: string, slot: number): string {
    const key = `${REQUEST_KEY_PREFIX}${today}:${slot}`;
    const cached = this.requestIds.get(key);
    if (cached) return cached;
    let stored: string | null = null;
    try {
      stored = sessionStorage.getItem(key);
    } catch {
      stored = null;
    }
    const id = stored ?? newUuid();
    this.requestIds.set(key, id);
    try {
      sessionStorage.setItem(key, id);
    } catch {
      /* storage unavailable: the in-memory map still covers a retry this session */
    }
    return id;
  }

  async getStatus(): Promise<DailyBonusStatus> {
    const response = await supabase.rpc('fn_ca_daily_bonus_status').then(
      (result) => result,
      (cause: unknown) => {
        throw new DailyBonusStatusError('rpc_error', cause, null, null, 'unavailable');
      }
    );
    const { data, error, status: httpStatus, statusText } = response;
    const payloadKind = data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data;
    if (error) {
      throw new DailyBonusStatusError(
        'rpc_error',
        error,
        httpStatus ?? null,
        statusText ?? null,
        payloadKind
      );
    }
    const status = data as DailyBonusStatus | null;
    if (!status || typeof status !== 'object' || Array.isArray(status)) {
      throw new DailyBonusStatusError(
        'invalid_payload',
        null,
        httpStatus ?? null,
        statusText ?? null,
        payloadKind
      );
    }
    return {
      ...status,
      eligible: status.eligible === true,
      shown_today: status.shown_today === true,
      unclaimed: Number(status.unclaimed) || 0,
      seconds_to_reset: Math.max(0, Number(status.seconds_to_reset) || 0),
      tiles: Array.isArray(status.tiles) ? status.tiles : [],
      week: Array.isArray(status.week) ? status.week : [],
      tomorrow: Array.isArray(status.tomorrow) ? status.tomorrow : [],
      caps: status.caps ?? null,
      // Phase 3 fields: a status from before the ledger learned them reads as
      // nothing held, nothing running, nothing protected.
      shield: {
        held: Math.max(0, Number(status.shield?.held) || 0),
        expires_at: status.shield?.expires_at ?? null,
      },
      boost:
        status.boost && status.boost.active === true
          ? {
              ...status.boost,
              active: true,
              seconds_left: Math.max(0, Number(status.boost.seconds_left) || 0),
            }
          : { active: false },
      streak_protected: status.streak_protected === true,
    };
  }

  /**
   * Record that today's sheet has been put in front of the player, so no
   * other device raises the popup again today. Idempotent server-side (the
   * first show wins); a failure is reported and otherwise ignored, the
   * browser's own day mark covers the gap.
   */
  async markShown(): Promise<void> {
    const { error } = await supabase.rpc('fn_ca_daily_bonus_mark_shown');
    if (error) reportError(error, 'DailyBonusService.markShown.fn_ca_daily_bonus_mark_shown');
  }

  /**
   * Claim one tile. Resolves with the server's verdict; only throws on a
   * transport failure. A refusal is a business outcome the sheet renders.
   */
  async claim(today: string, slot: number): Promise<DailyBonusClaimResult> {
    const requestId = this.requestIdFor(today, slot);
    const { data, error } = await supabase.rpc('fn_ca_daily_bonus_claim', {
      p_slot: slot,
      p_request_id: requestId,
      p_bonus_date: today,
    });
    if (error) {
      reportError(error, 'DailyBonusService.claim.fn_ca_daily_bonus_claim', { slot });
      throw new Error('Could Not Reach The Bonus Ledger, Try Again');
    }
    const result = (data ?? { success: false, reason: 'empty_response' }) as DailyBonusClaimResult;
    if (result.success && result.granted) {
      // The header and wallet re-read their balances; the amount comes from
      // the ledger, never from here. When the ledger reported the balance it
      // left behind, the header can paint it now rather than after a re-read.
      masterBus.emit('BALANCE_UPDATED', {
        source: result.granted.kind === 'diamonds' ? 'daily_bonus_diamonds' : 'daily_bonus_credit',
        slot,
      });
      if (result.granted.kind === 'diamonds' && typeof result.granted.balance_after === 'number') {
        masterBus.emit('DIAMOND_BALANCE_CHANGED', {
          newBalance: result.granted.balance_after,
          delta: result.granted.diamonds,
          source: 'daily_bonus',
        });
      }
      masterBus.emit('DAILY_REWARD_CLAIMED', {
        amount:
          result.granted.kind === 'diamonds' ? result.granted.diamonds : result.granted.quantity,
        rewardType: result.granted.kind,
        streakDay: result.streak ?? 0,
      });
    }
    return result;
  }
}

export const dailyBonusService = new DailyBonusServiceClass();

/** Cents for a diamond amount at the platform rate (1 diamond = 1 cent). */
export function diamondsToCentsLabel(diamonds: number, centsPerDiamond = 1): string {
  const cents = Math.round(diamonds * centsPerDiamond);
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${cents}¢`;
}
