/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND TOP-UP TOAST — Universal "Not Enough Diamonds" Notification
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shown whenever a diamond auto-deduct fails due to insufficient balance.
 * Includes a link to the Diamond Store and a VIP upsell message.
 *
 * Usage:
 *   import { showDiamondTopUp } from '../components/common/DiamondTopUpToast';
 *   showDiamondTopUp(toast, navigate, { feature: 'Throwable', cost: 1 });
 *
 * The toast is TAPPABLE and opens the diamond store. It does not navigate on
 * its own: this fires at a table, mid-hand, and yanking a player off the felt
 * because they could not afford a throwable would be worse than the dead end
 * it replaces.
 */

import type { useNavigate } from 'react-router-dom';

interface TopUpOptions {
  feature: string; // e.g. 'Throwable', 'Time Bank Extension'
  cost: number; // Diamond cost that couldn't be paid
  currentBalance?: number; // Optional current diamond balance
}

type ToastLike = {
  error: (msg: string, duration?: number, onClick?: () => void) => void;
  info: (msg: string, duration?: number, onClick?: () => void) => void;
};

type NavigateFn = ReturnType<typeof useNavigate>;

/**
 * Show a "not enough diamonds" notification with guidance
 */
export function showDiamondTopUp(
  toast: ToastLike,
  navigate: NavigateFn,
  options: TopUpOptions
): void {
  const { feature, cost, currentBalance } = options;

  const balanceMsg = currentBalance !== undefined ? `, You Have ${currentBalance}` : '';

  // THE NAVIGATE ARGUMENT NOW DOES SOMETHING (2026-09-11). This has taken a
  // navigate since it was written and never called it, so the "universal"
  // top-up path went nowhere: the message named a store it could not open. The
  // toast carries an onClick, so the message IS the door. Nobody is navigated
  // away on their own, which matters at a table where this fires mid-hand.
  toast.error(
    `Not Enough Diamonds For ${feature}, ${cost} Needed${balanceMsg}. Tap To Get Diamonds`,
    undefined,
    () => navigate('/marketplace?tab=diamonds')
  );
}

/**
 * Attempt a diamond purchase and auto-show top-up toast on failure
 * Returns true if purchase succeeded
 */
export async function attemptDiamondPurchase(
  purchaseFn: () => Promise<{ success: boolean; error?: string; charged?: number }>,
  toast: ToastLike,
  navigate: NavigateFn,
  featureName: string,
  cost: number
): Promise<boolean> {
  const result = await purchaseFn();

  if (result.success) {
    return true;
  }

  // Check if it's a balance issue
  if (
    result.error?.includes('diamonds') ||
    result.error?.includes('balance') ||
    result.error?.includes('insufficient')
  ) {
    showDiamondTopUp(toast, navigate, { feature: featureName, cost });
  } else {
    toast.error(result.error || `Failed to use ${featureName}`);
  }

  return false;
}

export default showDiamondTopUp;
