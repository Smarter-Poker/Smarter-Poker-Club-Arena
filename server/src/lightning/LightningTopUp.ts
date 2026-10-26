import { supabase } from '../services/supabase.js';

export interface LightningTopUpReceipt {
  success: boolean;
  queued: boolean;
  charged: boolean;
  applied: number;
  requested: number;
  request_id: string;
  table_id: string;
  user_id: string;
  pool_session_id: string;
  occupancy_id: string;
  stack: number | null;
  status: 'pending' | 'applied' | 'refused';
  error?: string;
  replayed?: boolean;
}

export function parseLightningTopUpReceipt(value: unknown): LightningTopUpReceipt {
  const r = value as Record<string, unknown> | null;
  if (!r || !['pending', 'applied', 'refused'].includes(String(r.status)))
    throw new Error('Malformed Lightning Top Up Receipt');
  for (const key of ['request_id', 'table_id', 'user_id', 'pool_session_id', 'occupancy_id'])
    if (typeof r[key] !== 'string' || !r[key]) throw new Error('Unscoped Lightning Top Up Receipt');
  const applied = Number(r.applied);
  const requested = Number(r.requested);
  const stack = r.stack === null ? null : Number(r.stack);
  if (
    !Number.isFinite(applied) ||
    !Number.isFinite(requested) ||
    requested <= 0 ||
    applied < 0 ||
    applied > requested ||
    (stack !== null && (!Number.isFinite(stack) || stack < 0)) ||
    r.queued !== (r.status === 'pending') ||
    r.charged !== (r.status === 'applied') ||
    r.success !== (r.status !== 'refused') ||
    (r.status !== 'applied' && applied !== 0)
  )
    throw new Error('Inconsistent Lightning Top Up Receipt');
  return { ...r, applied, requested, stack } as unknown as LightningTopUpReceipt;
}

/** One original request. An uncertain transport outcome never creates another id. */
export async function requestLightningTopUp(
  table: string,
  user: string,
  id: string,
  amount: number
) {
  const { data, error } = await supabase.rpc('fn_lightning_top_up_request', {
    p_table_id: table,
    p_user_id: user,
    p_request_id: id,
    p_amount: amount,
  });
  if (error) throw error;
  if (data?.success === false && !data?.status)
    return { success: false as const, error: String(data.error || 'Lightning Top Up Refused') };
  const r = parseLightningTopUpReceipt(data);
  if (r.table_id !== table || r.user_id !== user || r.request_id !== id || r.requested !== amount)
    throw new Error('Lightning Top Up Request Identity Changed');
  return r;
}
