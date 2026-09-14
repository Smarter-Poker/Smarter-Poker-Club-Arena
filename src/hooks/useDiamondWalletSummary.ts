import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { masterBus } from '../core/MasterBus';
import { DiamondService, type DiamondWalletSummary } from '../services/DiamondService';

/**
 * ONE READ OF THE DIAMOND WALLET, OWNED HERE SO EVERY PANE SEES THE SAME FIGURES.
 *
 * `fn_diamond_wallet_summary` (phase 1, 2026-09-13) returns on hand, sendable,
 * collateral, diamonds in Diamond Arena custody, the arena's open flags and the
 * lifetime totals in one call. This hook holds that answer for the page:
 *
 *   undefined  not read yet (or re-reading after the ledger changed)
 *   null       the read FAILED - the surface says Unavailable, never a zero
 *   object     the truth as of `readAt`
 *
 * It re-reads on BALANCE_UPDATED, debounced, so a claim, a gift or a buy-in
 * made from any pane moves every figure without a manual refresh. Last write
 * wins across overlapping reads.
 *
 * THE DIAMOND ARENA IS DIAMONDS ONLY. Nothing here is a chip.
 */
export interface DiamondWalletSummaryState {
  summary: DiamondWalletSummary | null | undefined;
  load: () => Promise<void>;
}

export function useDiamondWalletSummary(
  userId: string | undefined,
  isMounted: RefObject<boolean>
): DiamondWalletSummaryState {
  const [summary, setSummary] = useState<DiamondWalletSummary | null | undefined>(undefined);
  const seqRef = useRef(0);

  const load = useCallback(async () => {
    if (!userId) return;
    const seq = ++seqRef.current;
    const next = await DiamondService.getWalletSummary();
    if (!isMounted.current || seq !== seqRef.current) return;
    setSummary(next);
  }, [userId, isMounted]);

  // A different player is a different wallet.
  useEffect(() => {
    seqRef.current += 1;
    setSummary(undefined);
    if (userId) void load();
  }, [userId, load]);

  useEffect(() => {
    if (!userId) return;
    return masterBus.subscribeDebounced('BALANCE_UPDATED', () => void load(), 1200);
  }, [userId, load]);

  return { summary, load };
}
