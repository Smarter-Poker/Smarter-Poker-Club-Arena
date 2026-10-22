/**
 * Union Bank club balances (Dan, 2026-10-21): "WHEN I AM IN THE UNION BANK AND
 * I SELECT A CLUB, I NEED TO BE ABLE TO SEE THE CLUBS BALANCES."
 *
 * Club money columns are withheld from browser reads, so the balances come
 * from fn_union_club_bank_balances, a read-only SECURITY DEFINER function that
 * answers only the union owner or a union_lead (the same people
 * fn_union_clawback_from_club lets move that money). Anyone else, or a read
 * that fails, gets no balances: the screen shows nothing rather than a
 * made-up 0.
 */
import { supabase } from '../lib/supabase';

export interface UnionClubBalance {
  /** Club Bank (clubs.chip_treasury). */
  bank: number;
  /** Club Promo Wallet (clubs.promo_balance). */
  promo: number;
  /** The opening grant a clawback may not take the Club Bank below. */
  floor: number;
}

const finite = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Parse the RPC rows. A malformed row is dropped, never coerced to 0. */
export function parseUnionClubBalances(data: unknown): Map<string, UnionClubBalance> {
  const out = new Map<string, UnionClubBalance>();
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const bank = finite(r.club_bank);
    const promo = finite(r.club_promo);
    const floor = finite(r.pull_floor);
    if (typeof r.club_id !== 'string' || bank === null || promo === null || floor === null) continue;
    out.set(r.club_id, { bank, promo, floor: Math.max(0, floor) });
  }
  return out;
}

/** The most a pull may take from this wallet. The promo wallet has no floor. */
export function pullableFrom(balance: UnionClubBalance, promo: boolean): number {
  return promo ? Math.max(0, balance.promo) : Math.max(0, balance.bank - balance.floor);
}

export async function readUnionClubBalances(
  unionId: string
): Promise<Map<string, UnionClubBalance>> {
  const { data, error } = await supabase.rpc('fn_union_club_bank_balances', {
    p_union_id: unionId,
  });
  if (error) throw error;
  return parseUnionClubBalances(data);
}
