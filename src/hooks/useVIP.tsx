/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useVIP — VIP Status Hook for Club Arena
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Provides VIP status checking at entry and feature gating throughout the app.
 */

import { useState, useEffect, useCallback, createContext, useContext, ReactNode } from 'react';
import {
  vipService,
  VIPStatus,
  VIPFeature,
  FeatureAccess,
  FEATURE_PRICING,
} from '../services/VIPService';
import { useAuthUser } from './useAuthUser';
import { reportError } from '../utils/errorReporter';
import { masterBus } from '../core/MasterBus';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface VIPContextValue {
  isVIP: boolean;
  status: VIPStatus | null;
  isLoading: boolean;
  checkFeature: (feature: VIPFeature) => Promise<FeatureAccess>;
  useFeature: (feature: VIPFeature) => Promise<{ success: boolean; charged: number }>;
  refreshStatus: () => Promise<void>;
  getFeatureCost: (feature: VIPFeature) => number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

const VIPContext = createContext<VIPContextValue | null>(null);

// ═══════════════════════════════════════════════════════════════════════════════
// PROVIDER
// ═══════════════════════════════════════════════════════════════════════════════

export function VIPProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthUser();
  const [status, setStatus] = useState<VIPStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Check VIP status on mount and when user changes
  useEffect(() => {
    if (user?.id) {
      checkVIPStatus();
    } else {
      setStatus(null);
      setIsLoading(false);
    }
  }, [user?.id]);

  const checkVIPStatus = useCallback(async () => {
    if (!user?.id) return;

    setIsLoading(true);
    try {
      const vipStatus = await vipService.checkVIPStatus(user.id);
      setStatus(vipStatus);
    } catch (error) {
      /**
       * 2026-08-28: this used to write "not VIP, zero allowance" on ANY
       * failure, so one unreadable query took a paying member's features away
       * mid-session. The service now throws instead of inventing that answer,
       * and the right response to "we could not find out" is to KEEP WHAT WE
       * ALREADY KNEW — a stale true is far better than a fabricated false,
       * and the next call re-checks. Only the very first check on a fresh
       * mount has nothing to keep, and its initial state is already
       * non-VIP-with-zero-limits, so nothing is granted by accident either.
       */
      reportError(error, 'useVIP.Failed_to_check_VIP_status');
    }
    setIsLoading(false);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id) return undefined;
    return masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId !== user.id || event.payload.category !== 'vip') return;
      void checkVIPStatus();
    });
  }, [checkVIPStatus, user?.id]);

  const checkFeature = useCallback(
    async (feature: VIPFeature): Promise<FeatureAccess> => {
      if (!user?.id) {
        return {
          hasAccess: false,
          isVIP: false,
          needsPurchase: true,
          diamondCost: FEATURE_PRICING[feature].cost,
        };
      }
      return vipService.checkFeatureAccess(user.id, feature);
    },
    [user?.id]
  );

  const useFeature = useCallback(
    async (feature: VIPFeature): Promise<{ success: boolean; charged: number }> => {
      if (!user?.id) {
        return { success: false, charged: 0 };
      }
      const result = await vipService.useFeature(user.id, feature);
      // Refresh status after using feature
      if (result.success) {
        await checkVIPStatus();
      }
      return result;
    },
    [user?.id, checkVIPStatus]
  );

  const getFeatureCost = useCallback((feature: VIPFeature): number => {
    return FEATURE_PRICING[feature].cost;
  }, []);

  const value: VIPContextValue = {
    isVIP: status?.isVIP ?? false,
    status,
    isLoading,
    checkFeature,
    useFeature,
    refreshStatus: checkVIPStatus,
    getFeatureCost,
  };

  return <VIPContext.Provider value={value}>{children}</VIPContext.Provider>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════════

export function useVIP(): VIPContextValue {
  const context = useContext(VIPContext);
  if (!context) {
    throw new Error('useVIP must be used within a VIPProvider');
  }
  return context;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE HOOK (No provider required - for standalone use)
// ═══════════════════════════════════════════════════════════════════════════════

export function useVIPStatus() {
  const { user } = useAuthUser();
  const [isVIP, setIsVIP] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      if (!user?.id) {
        setIsVIP(false);
        setIsLoading(false);
        return;
      }

      /**
       * A FAILED READ IS NOT A DOWNGRADE (2026-09-05), and this hook was the
       * one place still saying it was.
       *
       * `vipService.checkVIPStatus` goes out of its way to THROW rather than
       * answer "not VIP" when the query errors - its own header explains why,
       * citing the two times this repo has already ruled against that shape
       * (`WalletService.getPlayerBalance`, `useWalletStore.loadDiamonds`): a
       * read that never happened is not an answer. This catch then threw that
       * intent away and wrote `false`, so ONE transient blip stripped a paying
       * member of every VIP-gated perk for the rest of the session, silently,
       * with no retry.
       *
       * It cost a real feature: the VIP all-in squeeze reads this hook, and a
       * member who lost the read simply never saw the perk again and had no
       * way to know why.
       *
       * So: one retry on a short backoff, and if the answer still never
       * arrives, KEEP WHAT WE ALREADY KNEW rather than inventing a downgrade.
       * The initial value is `false`, so a first read that fails still grants
       * nothing - fail closed on a perk we have never been able to confirm -
       * but a member confirmed once is not un-confirmed by a dropped packet.
       */
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const vip = await vipService.isVIP(user.id);
          if (mounted) setIsVIP(vip);
          break;
        } catch (e) {
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, 400));
            if (!mounted) return;
            continue;
          }
          reportError(e, 'useVIP.check');
          /* No setIsVIP here, deliberately. See above. */
        }
      }
      if (mounted) setIsLoading(false);
    };

    check();
    const unsubscribe = masterBus.subscribe('ENTITLEMENTS_CHANGED', (event) => {
      if (event.payload.userId === user?.id && event.payload.category === 'vip') void check();
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [user?.id]);

  return { isVIP, isLoading };
}
