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
 */

import type { useNavigate } from 'react-router-dom';

interface TopUpOptions {
  feature: string; // e.g. 'Throwable', 'Time Bank Extension'
  cost: number; // Diamond cost that couldn't be paid
  currentBalance?: number; // Optional current diamond balance
}

type ToastLike = {
  error: (msg: string) => void;
  info: (msg: string) => void;
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

  const balanceMsg = currentBalance !== undefined ? ` (You have ${currentBalance})` : '';

  toast.error(
    `Not enough diamonds for ${feature} (${cost} needed)${balanceMsg}. Top up in the Diamond Store!`
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
