/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SPIN ACTIVATION — the owner's switch
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-23: "SPINS SHOULD BE 'ACTIVATED' IN THE OWNERS MENU, AND WHEN
 * THEY ARE, THEY NEED TO DECIDE HOW MUCH THEY ARE 'SEEDING' INTO THE WALLET.
 * (THOSE FUNDS ARE RETURNED ONCE ENOUGH IS COLLECTED) AND ALL PROCEEDS ARE
 * KEPT THERE TO FUND THE MULTIPLIER PAYOUTS."
 *
 * WHY EVERY CALL HERE GOES THROUGH THE WORLD HUB AND NOT STRAIGHT TO SUPABASE.
 * fn_spin_activate and fn_spin_deactivate move real money and are REVOKEd from
 * anon and authenticated — a browser literally cannot execute them. The
 * database can prove the seed is big enough and that the wallet can afford it;
 * it cannot prove the caller is the owner. /api/club-arena/spin-activation
 * establishes that with the JWT and only then calls the function with the
 * service role.
 *
 * Reads go the same way rather than direct-to-Supabase, because who owns a
 * pool is itself the answer being asked for: fn_spin_reserve_owner resolves
 * COALESCE(clubs.union_id, club_id), so the club you ask about is often not
 * the club that holds the money.
 */

import { supabase } from '../lib/supabase';
import { uuid } from '../utils/uuid';
import { requiredSeed } from '../config/spinSpec';

/** The Spin board's price points. Mirrors SPIN_BOARD_BUYINS in the engine. */
export const SPIN_BOARD_STAKES = [1, 2, 3, 5, 10, 20, 50, 100] as const;

export type SpinOwnerKind = 'club' | 'union';

/** Wallets an owner can seed from, by what kind of owner they are. */
export const SPIN_SEED_SOURCES: Record<SpinOwnerKind, { value: string; label: string }[]> = {
  club: [
    { value: 'chip_treasury', label: 'Chip Treasury' },
    { value: 'promo_balance', label: 'Promo Balance' },
  ],
  union: [
    { value: 'chip_balance', label: 'Chip Balance' },
    { value: 'promo_wallet', label: 'Promo Wallet' },
    { value: 'rake_wallet', label: 'Rake Wallet' },
    { value: 'spin_reserve_wallet', label: 'Spin Reserve Wallet' },
  ],
};

export interface SpinOwnerState {
  ok: boolean;
  owner_id: string;
  owner_kind: SpinOwnerKind;
  is_active: boolean;
  activated_at?: string | null;
  balance: number;
  offered_max_stake: number;
  required_seed: number;
  seeded_amount: number;
  seed_source_wallet?: string | null;
  seed_returned_amount: number;
  seed_returned_at?: string | null;
  /** How much more play must collect before the seed is repaid. */
  seed_repayable_in: number;
  /**
   * False when a seed is outstanding with no recorded source wallet. The
   * repayment deliberately refuses to guess where money came from, so such a
   * seed can never come back and the menu must say so rather than let it look
   * like one that is merely waiting its turn.
   */
  seed_is_repayable: boolean;
  /**
   * The balance the pool must always hold to cover its biggest advertised
   * prize. Repayment never takes it below this, so the 100x is always real.
   */
  repay_floor: number;
  /** The balance at which the next instalment falls due (floor x 1.25). */
  repay_trigger_at: number;
  /** What would be returned right now. 0 when nothing is due. */
  next_instalment: number;
  collected_from_play: number;
  total_drawn: number;
  spin_count: number;
  bonus_count?: number;
}

/**
 * A caller that moves money passes its OWN key, held across retries
 * (2026-09-09). This helper used to mint `uuid()` inline on every request,
 * so `activate` - which seeds a spin pool out of a real wallet - had no
 * idempotency at all: a committed activation whose response was lost seeded
 * the pool a second time on the next press. A read (`get_state`) needs no
 * key and still gets a fresh one.
 */
async function call<T>(body: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');

  const response = await fetch('/api/club-arena/spin-activation', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey || uuid(),
    },
    body: JSON.stringify(body),
  });

  const data = await response
    .json()
    .catch(() => ({ success: false, error: `HTTP ${response.status}` }));

  if (!data.success) {
    throw new Error(data.error || `Spin activation request failed (HTTP ${response.status})`);
  }
  return data as T;
}

/**
 * The seed an owner must put up: two top-tier jackpots at the largest stake
 * they choose to offer. Mirrors fn_spin_required_seed in the database and
 * requiredSeed() in spinSpec — all three must agree, or an owner is quoted one
 * number and charged another.
 */
export function requiredSeedForStake(maxStake: number): number {
  /* 2026-08-30 audit: this used to hardcode the top multiplier as a literal
     100 - the exact drift shape the 500x retirement already burned us on.
     spinSpec.requiredSeed derives it from SPIN_TIERS, so a tier change now
     changes all three quotes together. */
  return requiredSeed(Math.max(maxStake, 0));
}

export const spinActivationApi = {
  /**
   * canManage is decided by the ROUTE, where union_admins and clubs.owner_id
   * actually are, and never inferred here. The panel used to work it out from
   * owner_kind and got it wrong in both directions -- hiding the off switch
   * from the union lead who may press it, and offering activation to a club
   * owner inside a union whose request the API answers 403.
   */
  getState(clubId: string) {
    return call<{ state: SpinOwnerState; ownerKind: SpinOwnerKind; canManage: boolean }>({
      action: 'get_state',
      clubId,
    });
  },

  /** `idempotencyKey` is the caller's, minted once for the purchase and
   *  reused on every retry of it - see the note on `call`. */
  activate(
    clubId: string,
    seedAmount: number,
    offeredMaxStake: number,
    sourceWallet: string,
    idempotencyKey?: string
  ) {
    return call<{ result: Record<string, unknown> }>(
      {
        action: 'activate',
        clubId,
        seedAmount,
        offeredMaxStake,
        sourceWallet,
      },
      idempotencyKey
    );
  },

  deactivate(clubId: string, idempotencyKey?: string) {
    return call<{ result: Record<string, unknown> }>(
      { action: 'deactivate', clubId },
      idempotencyKey
    );
  },
};
