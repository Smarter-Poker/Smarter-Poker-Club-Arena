/**
 * Supabase helpers — player/horse wallet funding (rebuys and top-ups).
 *
 * Split out of the 1,474-line `src/services/supabase.ts` module on 2026-08-08
 * (deploy tooling caps a single file at ~50 KB). This is a pure move: function
 * bodies are byte-identical to the original — the only edits are module
 * boundaries and the import of the shared client from `./client.js`.
 * `src/services/supabase.ts` remains as a barrel re-exporting every submodule,
 * so no import anywhere else in the codebase changed.
 */

import { supabase } from './client.js';
import { reportError } from '../errorReporter.js';

/**
 * Auto-rebuy a horse from their Player Wallet atomically.
 * ROUND 34 FIX: Direct UPDATE on public.wallets is rejected by the
 * Phase 4.1.6a wallet guard. All balance changes must flow through
 * whitelisted SECURITY DEFINER RPCs that log to chip_ledger. Replaced
 * the manual 4-step sequence (select + update wallet + update seat +
 * insert audit row) with the atomic_table_rebuy RPC, which performs
 * all 4 atomically and is whitelisted.
 *
 * Caller signature kept stable; clubId is passed but not consumed —
 * the RPC resolves it from tables(id) transitively.
 */
export async function autoRebuyHorse(
  tableId: string,
  userId: string,
  rebuyAmount: number,
  clubId: string
): Promise<boolean> {
  void clubId;
  try {
    // Fund the horse rebuy from the TABLE's club treasury (fn_horse_fund_from
    // _treasury derives the club from the table). Horses no longer draw on a
    // globally-minted wallet — the chips come from the club's real bankroll and
    // the rebuy fails cleanly if the treasury is short (the horse busts, correct
    // conservation behavior). Real-player rebuys still use atomic_table_rebuy.
    const { data, error } = await supabase.rpc('fn_horse_fund_from_treasury', {
      p_table_id: tableId,
      p_user_id: userId,
      p_amount: rebuyAmount,
    });

    if (error || !data?.success) {
      const msg = error?.message || data?.error || '';
      if (!msg.includes('insufficient') && !msg.includes('no active seat')) {
        reportError(
          new Error(msg || 'horse treasury rebuy failed'),
          'DB.horse_treasury_rebuy_failed'
        );
      }
      return false;
    }

    return true;
  } catch (err: any) {
    reportError(err, 'DB.Unexpected_horse_treasury_rebuy');
    return false;
  }
}

/**
 * Ensure a horse's wallet is properly funded.
 * Called during fleet startup to top up horses that ran low.
 */
export async function ensureHorseWallet(
  horseId: string,
  minBalance: number = 10000
): Promise<void> {
  const { data: wallet } = await supabase
    .from('wallets')
    .select('id, balance')
    .eq('user_id', horseId)
    .eq('wallet_type', 'PLAYER')
    .maybeSingle();

  if (!wallet) {
    // Create wallet
    await supabase.from('wallets').insert({
      user_id: horseId,
      wallet_type: 'PLAYER',
      balance: minBalance,
      locked_balance: 0,
    });
    return;
  }

  if (wallet.balance < minBalance) {
    const topUp = minBalance - wallet.balance;
    // 2026-08-22: this is read-then-write — the balance is SELECTed above and
    // the top-up computed from it — with no key, so two passes that read the
    // same balance both credited the difference and the horse ended up with
    // 2x the floor. The lifecycle sweep and AutoRebuyService can both be in
    // here at once. Keyed on the balance that was actually observed, so a
    // duplicate of THIS decision is a DB-side no-op while a genuine later
    // refill (a different observed balance) still goes through.
    // fn_credit_player_wallet_once rather than credit_player_wallet: it is the
    // same body, but it RETURNS whether THIS call performed the credit. The
    // ledger insert below is gated on that, so the deduped second pass writes
    // no row — the credit and the row stay in step. (credit_player_wallet
    // returns void, which is precisely how the tournament prize paths ended up
    // writing 95 phantom rows before 2026-08-22.)
    const { data: didCredit, error: refillErr } = await supabase.rpc(
      'fn_credit_player_wallet_once',
      {
        p_user_id: horseId,
        p_amount: topUp,
        p_idempotency_key: `horse-refill:${horseId}:${wallet.id}:${wallet.balance}:${minBalance}`,
      }
    );

    if (refillErr) {
      reportError(
        new Error(`[refillHorseWallet] Credit failed for horse ${horseId}: ${refillErr.message}`),
        'refillHorseWallet.Credit_failed_for_horse_horseI'
      );
      return;
    }

    // Someone else already made this exact top-up. Their row is the only one
    // that should exist.
    if (didCredit === false) return;

    // BUG 018 FIX: compute balance_after from the known prior balance + topup
    const newBalance = Number(wallet.balance ?? 0) + topUp;
    const { error: refillTxErr } = await supabase.from('wallet_transactions').insert({
      user_id: horseId,
      wallet_type: 'PLAYER',
      amount: topUp,
      type: 'credit',
      category: 'horse_refill',
      description: `Horse wallet refill: ${topUp} chips (balance was ${wallet.balance})`,
      balance_after: newBalance,
    });
    if (refillTxErr)
      console.warn(
        `[DB] Horse refill tx log failed for ${horseId.slice(0, 8)}: ${refillTxErr.message}`
      );
  }
}
