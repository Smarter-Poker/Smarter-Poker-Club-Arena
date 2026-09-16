/**
 * WHAT VIP IS, IN ONE PLACE.
 *
 * Dan, 2026-09-04: "THERE IS NO SUCH THING AS 'PLATINUM VIP' BTW. JUST VIP,
 * AND LIFETIME VIP."
 *
 * The profile page had a five-rung bronze -> diamond ladder driven by the
 * diamond balance, a progress ring to the "next tier" and a benefits list
 * ("Unlimited Throwables", "Auto Time Bank") that the VIP page never promised.
 * None of it exists in the data. profiles carries three VIP columns:
 *
 *   is_vip          boolean   the membership switch
 *   vip_tier        text      'lifetime' | 'monthly' | null
 *   vip_expires_at  timestamp only meaningful for a monthly membership
 *
 * (`profiles.tier` is NOT a VIP column - every row reads 'Newcomer'.)
 *
 * So there are exactly three answers, and this is the only resolver.
 */
import { resolveActiveVip } from '../stores/useHeaderDataStore';

export type VipStatus = 'none' | 'vip' | 'lifetime';

export interface VipColumns {
  is_vip?: boolean | null;
  vip_tier?: string | null;
  vip_expires_at?: string | null;
}

export function resolveVipStatus(row: VipColumns | null | undefined, now = Date.now()): VipStatus {
  if (!row?.is_vip) return 'none';
  // A lifetime membership does not expire, whatever a stale expiry column says.
  if ((row.vip_tier || '').toLowerCase() === 'lifetime') return 'lifetime';
  return resolveActiveVip(true, row.vip_expires_at ?? null, now) ? 'vip' : 'none';
}

export function vipStatusLabel(status: VipStatus): string {
  if (status === 'lifetime') return 'Lifetime VIP';
  if (status === 'vip') return 'VIP';
  return 'Not VIP';
}
