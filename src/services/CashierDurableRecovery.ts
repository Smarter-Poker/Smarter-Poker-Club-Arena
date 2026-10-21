import { supabase } from '../lib/supabase';

export type RecoveryKind = 'wallet' | 'transfer';
export function recoveryCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(recoveryCanonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${recoveryCanonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function recoveryDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(recoveryCanonical(value))
  );
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function durableRecovery<T>(
  method: 'reserve' | 'read' | 'update' | 'ack',
  userId: string,
  clubId: string,
  kind: RecoveryKind,
  key?: string,
  envelope?: T,
  identity?: string
): Promise<unknown> {
  const args: Record<string, unknown> = { p_actor_id: userId, p_club_id: clubId, p_kind: kind };
  if (key !== undefined) args.p_intent_key = key;
  if (envelope !== undefined) args.p_envelope = envelope;
  if (identity !== undefined) args.p_identity = identity;
  const { data, error } = await supabase.rpc(`fn_cashier_browser_recovery_${method}`, args);
  if (error) throw error;
  return data;
}
