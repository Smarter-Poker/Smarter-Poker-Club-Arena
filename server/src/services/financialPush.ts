/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL_UPDATE HAS A PRODUCER (final sweep 2, 2026-09-08)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The client's wallet page and cashier stopped listening to Supabase Realtime
 * on 2026-05-18 and listen to the channel socket's FINANCIAL_UPDATE instead
 * (src/hooks/useRealtimeFinancials.ts). The message was declared in
 * ChannelHub's OutboundMessage union that day - and nothing on this server has
 * ever sent one. Every balance change a player made or was paid at a table
 * reached their wallet screen only when something else happened to refetch
 * it (a reconnect, a page change).
 *
 * This is the producer. It is called AFTER a wallet mutation this process
 * made on a player's behalf - a cash-out, an add-on landing with its capped
 * remainder refunded - reads the balance the mutation left, and pushes it to
 * every socket that player holds. The consumer treats the numbers as advisory
 * and refetches on receipt, so what matters is that the push happens at all,
 * promptly, after the write has committed.
 *
 * Fire-and-forget: a failed push is reported and never touches the money path
 * that triggered it. A horse has no socket, so sendToUser is a no-op for it.
 *
 * NOT COVERED HERE: wallet writes made by SQL sweeps (tournament prizes,
 * rakeback, refunds paid by pg_cron) - those run outside this process. The
 * reconnect refetch in the hook still covers them; a database-side NOTIFY is
 * the honest next step if that gap matters.
 */

import { supabase } from './supabase/client.js';
import { channelHub } from '../hub/ChannelHub.js';
import { reportError } from './errorReporter.js';

export interface FinancialPushOptions {
  /** Authoritative asset from the committed custody receipt. */
  asset?: 'chips' | 'diamonds';
  /** The club whose wallet moved, when the caller knows it. */
  clubId?: string | null;
  /** The table the mutation happened at; resolves the club when clubId is absent. */
  tableId?: string | null;
  /** What moved, for the client's transaction feed. */
  ledgerEntry?: { direction: 'in' | 'out'; amount: number; kind: string } | null;
}

/** Resolve the club, read the balance, push. Exported for tests. */
export async function pushFinancialUpdateNow(
  userId: string,
  opts: FinancialPushOptions = {}
): Promise<boolean> {
  if (!userId || userId === 'undefined') return false;
  if (opts.asset === 'diamonds') {
    const { data, error } = await supabase
      .from('profiles')
      .select('diamonds')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw error;
    const balance = data?.diamonds;
    if (typeof balance !== 'number' || !Number.isSafeInteger(balance) || balance < 0) return false;
    channelHub.sendToUser(userId, {
      type: 'FINANCIAL_UPDATE',
      userId,
      walletType: 'DIAMOND',
      available: balance,
      total: balance,
    });
    return true;
  }
  let clubId = opts.clubId ?? null;
  if (!clubId && opts.tableId) {
    const { data, error } = await supabase
      .from('tables')
      .select('club_id')
      .eq('id', opts.tableId)
      .maybeSingle();
    if (error) throw error;
    clubId = (data as { club_id?: string | null } | null)?.club_id ?? null;
  }
  if (!clubId) return false;
  const { data: member, error: memberErr } = await supabase
    .from('club_members')
    .select('chip_balance')
    .eq('club_id', clubId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memberErr) throw memberErr;
  const balance = Number((member as { chip_balance?: unknown } | null)?.chip_balance);
  if (!Number.isFinite(balance)) return false;
  channelHub.sendToUser(userId, {
    type: 'FINANCIAL_UPDATE',
    userId,
    walletType: 'PLAYER',
    available: balance,
    total: balance,
    ledgerEntry: opts.ledgerEntry ?? undefined,
  });
  return true;
}

/** The call sites use this: never awaited, never throws into the money path. */
export function pushFinancialUpdate(userId: string, opts: FinancialPushOptions = {}): void {
  void pushFinancialUpdateNow(userId, opts).catch((err) =>
    reportError(err, 'financialPush.push_failed', { userId, tableId: opts.tableId ?? null })
  );
}
