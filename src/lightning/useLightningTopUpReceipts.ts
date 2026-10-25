import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

export interface LightningFundingSnapshot {
  pool_session_id: string;
  user_id: string;
  baseline: number;
  applied_count: number;
  balance: number;
  receipts: Array<{ status: string; request_id: string; applied: number }>;
}

/** Mount/reconnect and committed events read canonical totals. Never add a receipt delta. */
export function useLightningTopUpReceipts(args: {
  pool: string | null;
  user: string | null | undefined;
  event: Record<string, unknown> | null;
  version: number;
  connection?: string;
  ready?: boolean;
  revision: () => number;
  apply: (snapshot: LightningFundingSnapshot, revision: number) => void;
}) {
  const latest = useRef(args);
  latest.current = args;
  const event = args.event;
  const relevant =
    event?.type === 'lightning_top_up_completed' || event?.type === 'hand_history_saved';
  const trigger = relevant ? event : null;
  useEffect(() => {
    if (
      args.ready !== true ||
      !args.pool ||
      !args.user ||
      args.user === 'guest' ||
      (args.connection !== undefined && args.connection !== 'connected')
    )
      return;
    let stale = false;
    const pool = args.pool,
      user = args.user,
      revision = latest.current.revision();
    void Promise.resolve(supabase.rpc('fn_lightning_top_up_receipts', { p_pool_session_id: pool }))
      .then(({ data, error }) => {
        if (error) throw error;
        if (
          stale ||
          !data ||
          latest.current.ready !== true ||
          latest.current.pool !== pool ||
          latest.current.user !== user
        )
          return;
        const baseline = Number(data.baseline),
          balance = Number(data.balance),
          count = Number(data.applied_count);
        if (
          data.pool_session_id !== pool ||
          data.user_id !== user ||
          !Number.isFinite(baseline) ||
          baseline < 0 ||
          !Number.isFinite(balance) ||
          balance < 0 ||
          !Number.isSafeInteger(count) ||
          count < 0 ||
          !Array.isArray(data.receipts)
        )
          throw new Error('Malformed Lightning Funding Snapshot');
        latest.current.apply({ ...data, baseline, balance, applied_count: count }, revision);
      })
      .catch((error) => {
        if (!stale) reportError(error, 'LightningTopUp.receipt_read');
      });
    return () => {
      stale = true;
    };
  }, [args.pool, args.user, args.version, args.connection, args.ready, trigger]);
}
