/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THE RABBIT HUNT TILE KNOWS ON ITS FIRST FRAME (2026-10-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-11: "Rabbit hunts aren't unlimited even to VIP PLAYERS".
 *
 * The server was never the problem. `fn_consume_rabbit_hunt_v2` returns
 * `source: 'lifetime_vip', diamonds_spent: 0` for every Lifetime VIP before
 * any cap or price is read, and production agrees: every rabbit-hunt receipt
 * on the platform (28 of 28, the two Lifetime accounts that have ever hunted)
 * is `lifetime_vip` with 0 diamonds spent, and `rabbit_hunt_reveals` records
 * 0 charged on all 30 reveals.
 *
 * The TILE was the problem. TablePage mounts <RabbitHunt> fresh for every
 * offer (`hudSlotControl === 'rabbit'`), and the tile started every mount at
 * `isVIP = false, isLifetime = false`, then asked `vipService.checkVIPStatus`
 * - three round trips (profiles, vip_feature_usage_monthly, throw_usage) -
 * before it could say anything else. The offer is up for about two seconds.
 * So on every hand a Lifetime member first saw the paid tile: a "5" diamond
 * pill and "Rabbit Hunt, 5 Diamonds", the exact picture of a player who has
 * run out. When that lookup failed, the catch (correctly) kept what the tile
 * already knew - which on a fresh mount was "not VIP" - and the paid price
 * stayed up for the whole offer. The edge logs show the three reads firing
 * again from the owner's own browser on every offer.
 *
 * The fix is to start from what is already known, never from "not VIP":
 *
 *   1. The signed-in profile in useUserStore already carries `vip_status`,
 *      resolved by `utils/vipStatus` at sign-in. A Lifetime member is
 *      unconditionally free and uncapped, so that alone is enough to paint
 *      "Unlimited" on the first frame.
 *   2. The last answer this session confirmed for the SAME player is reused
 *      on the next mount, so an ordinary VIP's remaining count and a failed
 *      refresh no longer collapse to the paid tile.
 *
 * What it deliberately does NOT do: tell an ordinary VIP "Free" from the
 * store's flag alone. Their 100 free hunts a month are finite and the 101st
 * costs 5 Diamonds; "Free" before the count is known would be a promise the
 * server does not keep. Without a confirmed count they see the price until
 * the lookup answers, exactly as before. A non-VIP is unchanged in every case.
 *
 * Every entry is keyed by user id, so nothing here can cross an account
 * boundary, and none of it reaches the charge: the price is decided by the
 * engine and the database either way. This is the label.
 */
import type { VipStatus } from '../../utils/vipStatus';

export interface RabbitEntitlement {
  isVIP: boolean;
  isLifetime: boolean;
  /** Ordinary VIP free hunts left this month; null when unknown or unlimited. */
  vipRemaining: number | null;
}

const NONE: RabbitEntitlement = { isVIP: false, isLifetime: false, vipRemaining: null };

/** Last confirmed answer, by user id. Session memory only. */
const confirmed = new Map<string, RabbitEntitlement>();
const confirmedMonth = new Map<string, string>();
function usageMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}
// A lookup begun before a purchase must not rewind that purchase's count.
const usageVersions = new Map<string, number>();
export function rabbitVipUsageVersion(userId: string): number {
  return usageVersions.get(userId) ?? 0;
}

export function rememberRabbitEntitlement(userId: string, value: RabbitEntitlement): void {
  confirmedMonth.set(userId, usageMonth());
  confirmed.set(userId, {
    isVIP: value.isVIP || value.isLifetime,
    isLifetime: value.isLifetime,
    vipRemaining: value.isLifetime ? null : value.vipRemaining,
  });
}

/**
 * After a reveal the server reports the ordinary VIP pool's new count. Keep
 * it, so the next hand's tile opens on the true number rather than last
 * hand's.
 */
export function rememberRabbitVipRemaining(userId: string, remaining: number | null): void {
  const prior = confirmed.get(userId);
  if (typeof remaining !== 'number' || !Number.isFinite(remaining) || remaining < 0) return;
  if (prior?.isLifetime) return;
  usageVersions.set(userId, rabbitVipUsageVersion(userId) + 1);
  // Within one monthly pool, a delayed receipt cannot put a spent use back.
  const current = confirmedMonth.get(userId) === usageMonth() ? prior?.vipRemaining : null;
  confirmedMonth.set(userId, usageMonth());
  confirmed.set(userId, {
    isVIP: true,
    isLifetime: false,
    vipRemaining: typeof current === 'number' ? Math.min(current, remaining) : remaining,
  });
}

/**
 * What the tile shows before its own lookup answers.
 *
 * `profile` is the signed-in profile from useUserStore. It is used only when
 * it belongs to `userId`, and only for the Lifetime answer.
 */
export function initialRabbitEntitlement(
  userId: string | null | undefined,
  profile: { id?: string | null; vip_status?: VipStatus | null } | null | undefined
): RabbitEntitlement {
  if (!userId) return NONE;
  const known = confirmed.get(userId);
  if (known?.isLifetime) return known;
  if (profile?.id === userId && profile.vip_status === 'lifetime') {
    return { isVIP: true, isLifetime: true, vipRemaining: null };
  }
  return confirmedMonth.get(userId) === usageMonth() ? (known ?? NONE) : NONE;
}

/** Test seam: forget every confirmed answer. */
export function __resetRabbitEntitlementCache(): void {
  confirmed.clear();
  usageVersions.clear();
  confirmedMonth.clear();
}
