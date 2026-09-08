/** Owner policy: identical across cash, MTT, Spins and every Sit & Go. */
export const RECONNECT_BASE_SECONDS = 30;
export const RECONNECT_VIP_MULTIPLIER = 1.5;

export interface ReconnectMembership {
  is_vip?: boolean | null;
  vip_tier?: string | null;
  vip_expires_at?: string | null;
}

/** Server-read membership only. Purchased time banks are not VIP membership. */
export function reconnectProtectionSeconds(member: ReconnectMembership, now = Date.now()): number {
  const active =
    member.is_vip === true &&
    (member.vip_tier === 'lifetime' ||
      member.vip_expires_at === null ||
      (typeof member.vip_expires_at === 'string' && Date.parse(member.vip_expires_at) > now));
  return RECONNECT_BASE_SECONDS * (active ? RECONNECT_VIP_MULTIPLIER : 1);
}
