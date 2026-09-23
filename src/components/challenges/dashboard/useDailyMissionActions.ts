import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { masterBus } from '../../../core/MasterBus';
import { triggerHaptic } from '../../../services/HapticService';
import {
  DAILY_MISSION_REROLL_COST,
  dailyChallengeService,
  type TieredUserChallenge,
  type DailyChallengeDashboard,
  type DailyChallengeRewardVault,
} from '../../../services/DailyChallengeService';
import type { useIsMounted } from '../../../hooks/useIsMounted';
import { reportError } from '../../../utils/errorReporter';
import { capture } from '../../../lib/analytics';
import {
  dailyMissionReasonCode,
  recordDailyMissionOperation,
} from '../../../services/DailyMissionTelemetryService';
import type { ToastContextValue } from '../../../components/common/Toast';
import { focusAfterMissionUpdate, type TieredChallenge } from './missionPresentation';

/**
 * Every balance-changing action on the Daily Challenges page: claim, streak
 * freeze purchase, reroll and claim-all, with the guards that serialize them,
 * the busy and confirmation state they paint, the reroll Escape and stale
 * confirmation effects, and the freeze dialog focus restoration. The loader
 * refs it bumps (`mutationEpochRef`, `diamondBalanceRef`) are owned by the
 * dashboard loader and passed in, so there is exactly one instance of each.
 */
export function useDailyMissionActions({
  userId,
  diamondBalance,
  challenges,
  setChallenges,
  setRewardVault,
  installDashboardProjection,
  loadChallenges,
  refs,
  isMountedRef,
  toast,
}: {
  userId: string | null;
  diamondBalance: number;
  challenges: TieredChallenge[];
  setChallenges: Dispatch<SetStateAction<TieredChallenge[]>>;
  setRewardVault: Dispatch<SetStateAction<DailyChallengeRewardVault>>;
  installDashboardProjection: (dashboard: DailyChallengeDashboard) => boolean;
  loadChallenges: (uid: string, mode: 'initial' | 'refresh' | 'silent') => Promise<void>;
  refs: { mutationEpochRef: RefObject<number>; diamondBalanceRef: RefObject<number> };
  isMountedRef: ReturnType<typeof useIsMounted>;
  toast: ToastContextValue;
}) {
  const { mutationEpochRef, diamondBalanceRef } = refs;

  // Claiming state
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [claimingAll, setClaimingAll] = useState(false);
  const [rerollingIds, setRerollingIds] = useState<Set<string>>(new Set());
  const [confirmingRerollId, setConfirmingRerollId] = useState<string | null>(null);
  const [buyingFreeze, setBuyingFreeze] = useState(false);
  const [confirmingFreeze, setConfirmingFreeze] = useState(false);
  const [economyBusy, setEconomyBusy] = useState(false);
  const claimGuardRef = useRef(new Set<string>()); // Prevent double-clicks bypassing React state
  const claimAllGuardRef = useRef(false);
  const rerollGuardRef = useRef(new Set<string>());
  const buyFreezeGuardRef = useRef(false);
  const economyGuardRef = useRef(false);
  const freezeFocusRestorePendingRef = useRef(false);

  // Celebration state
  const [celebratingIds, setCelebratingIds] = useState<Set<string>>(new Set());
  /* No `chips` field: a mission reward is diamonds, and since migration
     20260905114421 the RPC returns a literal 0 for every chip figure. A field
     that can only ever be zero is an invitation to render "+0 Chips". */
  const [reward, setReward] = useState<{
    name: string;
    diamonds: number;
    challengeDiamonds: number;
    milestoneDiamonds: number;
    diamondBalance: number;
    returnFocusId: string;
  } | null>(null);

  // Escape always cancels the active reroll confirmation, even after focus
  // moves to another card. The inline control still owns the visible prompt,
  // while this page-level listener guarantees a consistent keyboard exit.
  useEffect(() => {
    if (!confirmingRerollId) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmingRerollId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingRerollId]);

  // A completion can arrive from another table or device while this card's
  // inline reroll confirmation is open. Once that assignment is no longer
  // rerollable, close the stale confirmation so it cannot keep every other
  // card's reroll control disabled.
  useEffect(() => {
    if (!confirmingRerollId) return;
    const confirmingChallenge = challenges.find((challenge) => challenge.id === confirmingRerollId);
    if (!confirmingChallenge || confirmingChallenge.completed || confirmingChallenge.claimed) {
      setConfirmingRerollId(null);
    }
  }, [challenges, confirmingRerollId]);

  // ── Claim handler ──
  const handleClaim = useCallback(
    async (challenge: TieredChallenge) => {
      if (!userId) return;
      if (claimGuardRef.current.has(challenge.id) || economyGuardRef.current) return;
      economyGuardRef.current = true;
      setEconomyBusy(true);
      claimGuardRef.current.add(challenge.id);
      setClaimingIds((prev) => new Set(prev).add(challenge.id));
      const startedAt = performance.now();

      try {
        const paid = await dailyChallengeService.claimChallenges(userId, [challenge.id]);
        const newlyClaimed = paid.claimedIds.includes(challenge.id);
        const alreadyClaimed = paid.alreadyClaimedIds.includes(challenge.id);

        mutationEpochRef.current += 1;
        const projectionInstalled = paid.dashboard
          ? installDashboardProjection(paid.dashboard)
          : false;
        const rewardBalance = paid.dashboard
          ? projectionInstalled
            ? paid.dashboard.diamondBalance
            : diamondBalanceRef.current
          : paid.settlementDiamondBalance;
        if (!paid.dashboard) void loadChallenges(userId, 'silent');

        if (alreadyClaimed && !newlyClaimed) {
          toast.info('You Already Claimed This One');
          focusAfterMissionUpdate(`mission-card-${challenge.id}`);
        } else if (newlyClaimed) {
          setReward({
            name: challenge.challenge.name,
            diamonds: paid.diamondsCredited,
            challengeDiamonds: paid.challengeDiamonds,
            milestoneDiamonds: paid.milestoneDiamonds,
            diamondBalance: rewardBalance,
            returnFocusId: `mission-card-${challenge.id}`,
          });
        } else {
          throw new Error('The claim receipt did not settle this reward');
        }

        setChallenges((prev) =>
          prev.map((c) => (c.id === challenge.id ? { ...c, claimed: true } : c))
        );
        if (newlyClaimed) {
          capture('daily_mission_claimed', {
            tier: challenge.tier,
            diamond_reward: paid.diamondsCredited,
            challenge_diamonds: paid.challengeDiamonds,
            milestone_diamonds: paid.milestoneDiamonds,
            claim_count: 1,
          });
          recordDailyMissionOperation({
            userId,
            event: 'claim_succeeded',
            tier: challenge.tier,
            durationMs: performance.now() - startedAt,
            itemCount: 1,
          });
          triggerHaptic('success');
          setCelebratingIds((prev) => new Set(prev).add(challenge.id));

          setTimeout(() => {
            if (isMountedRef.current) {
              setCelebratingIds((prev) => {
                const next = new Set(prev);
                next.delete(challenge.id);
                return next;
              });
            }
          }, 3000);

          masterBus.emit('MISSION_CLAIMED', {
            missionId: challenge.id,
            tier: challenge.tier,
            rewardType: 'diamonds',
            rewardAmount: paid.diamondsCredited,
          });
        }
      } catch (err: any) {
        reportError(err, 'DailyChallengesPage.claim_failed');
        recordDailyMissionOperation({
          userId,
          event: 'claim_failed',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
          reasonCode: dailyMissionReasonCode(err),
        });
        if (isMountedRef.current) {
          toast.error('Reward Status Could Not Be Confirmed. Refreshing Your Challenge Ledger.');
        }
        loadChallenges(userId, 'silent');
      } finally {
        claimGuardRef.current.delete(challenge.id);
        economyGuardRef.current = false;
        if (isMountedRef.current) {
          setEconomyBusy(false);
          setClaimingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    [
      userId,
      installDashboardProjection,
      loadChallenges,
      toast,
      isMountedRef,
      diamondBalanceRef,
      mutationEpochRef,
      setChallenges,
    ]
  );

  // ── Claim All ──
  //
  // One database-owned batch settles every currently vaulted reward under one
  // profile lock and one request receipt. The overlay shows the combined total
  // rather than flashing once for every challenge.

  const dismissFreezePurchase = useCallback(() => {
    if (buyFreezeGuardRef.current) return;
    freezeFocusRestorePendingRef.current = true;
    setConfirmingFreeze(false);
  }, []);

  useEffect(() => {
    if (confirmingFreeze || economyBusy || !freezeFocusRestorePendingRef.current) return undefined;

    freezeFocusRestorePendingRef.current = false;
    const frame = requestAnimationFrame(() => {
      const buyButton = document.getElementById('buy-streak-freeze') as HTMLButtonElement | null;
      if (buyButton && !buyButton.disabled) {
        buyButton.focus();
        return;
      }
      document.getElementById('streak-console-title')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [confirmingFreeze, economyBusy]);

  useEffect(() => {
    if (!confirmingFreeze) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissFreezePurchase();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [confirmingFreeze, dismissFreezePurchase]);

  const handleBuyFreeze = useCallback(async () => {
    if (!userId || buyingFreeze || buyFreezeGuardRef.current || economyGuardRef.current) return;
    if (diamondBalance < 5000) {
      freezeFocusRestorePendingRef.current = true;
      setConfirmingFreeze(false);
      toast.error('Not Enough Diamonds. You Need 5,000 Diamonds To Buy A Freeze.');
      return;
    }

    // Keep the portal and inert shell until the request settles. Removing
    // them on the first click lets a second click activate navigation below.
    freezeFocusRestorePendingRef.current = true;
    buyFreezeGuardRef.current = true;
    economyGuardRef.current = true;
    mutationEpochRef.current += 1;
    setBuyingFreeze(true);
    setEconomyBusy(true);

    const startedAt = performance.now();
    try {
      const res = await dailyChallengeService.buyStreakFreeze(userId);
      if (res.success) {
        // A dashboard read can begin while the purchase RPC is in flight and
        // still represent the pre-purchase snapshot. Invalidate that receipt
        // before applying the authoritative purchase result.
        mutationEpochRef.current += 1;
        capture('daily_mission_freeze_purchased', {
          replayed: res.alreadyPurchased,
          diamond_cost: res.diamondsSpent ?? 0,
        });
        recordDailyMissionOperation({
          userId,
          event: 'freeze_succeeded',
          durationMs: performance.now() - startedAt,
        });
        toast.success(
          res.alreadyPurchased ? 'Streak Freeze Purchase Confirmed.' : 'Streak Freeze Purchased.'
        );
        // The purchase receipt proves the spend, but its balance/inventory can
        // already be behind another tab. Paint only the revision-bearing
        // dashboard projection read after the mutation.
        await loadChallenges(userId, 'silent');
      } else {
        recordDailyMissionOperation({
          userId,
          event: 'freeze_failed',
          durationMs: performance.now() - startedAt,
          reasonCode: 'rejected',
        });
        toast.error(
          'Streak Freeze Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
        );
        loadChallenges(userId, 'silent');
      }
    } catch (err) {
      reportError(err, 'DailyChallengesPage.freeze_failed');
      recordDailyMissionOperation({
        userId,
        event: 'freeze_failed',
        durationMs: performance.now() - startedAt,
        reasonCode: dailyMissionReasonCode(err),
      });
      toast.error('Streak Freeze Status Could Not Be Confirmed. Refreshing Your Diamond Balance.');
      loadChallenges(userId, 'silent');
    } finally {
      buyFreezeGuardRef.current = false;
      economyGuardRef.current = false;
      if (isMountedRef.current) {
        setConfirmingFreeze(false);
        setBuyingFreeze(false);
        setEconomyBusy(false);
      }
    }
  }, [userId, buyingFreeze, diamondBalance, toast, loadChallenges, isMountedRef, mutationEpochRef]);

  const handleReroll = useCallback(
    async (challenge: TieredUserChallenge) => {
      if (!userId) return;
      if (rerollGuardRef.current.has(challenge.id) || economyGuardRef.current) return;
      if (diamondBalance < DAILY_MISSION_REROLL_COST) {
        setConfirmingRerollId(null);
        toast.error(`Not Enough Diamonds. ${DAILY_MISSION_REROLL_COST} Diamond Required.`);
        return;
      }

      economyGuardRef.current = true;
      setEconomyBusy(true);
      rerollGuardRef.current.add(challenge.id);
      setRerollingIds((prev) => new Set(prev).add(challenge.id));
      const startedAt = performance.now();
      try {
        const result = await dailyChallengeService.rerollChallenge(
          userId,
          challenge.id,
          challenge.challengeId
        );
        if (!result.success) {
          recordDailyMissionOperation({
            userId,
            event: 'reroll_failed',
            tier: challenge.tier,
            durationMs: performance.now() - startedAt,
            reasonCode: 'rejected',
          });
          toast.error(
            'Challenge Reroll Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
          );
          loadChallenges(userId, 'silent');
          return;
        }
        setConfirmingRerollId(null);
        mutationEpochRef.current += 1;
        capture('daily_mission_rerolled', {
          tier: challenge.tier,
          replayed: result.alreadyRerolled,
          diamond_cost: result.diamondsSpent ?? 0,
        });
        recordDailyMissionOperation({
          userId,
          event: 'reroll_succeeded',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
        });
        toast.success(
          result.alreadyRerolled
            ? 'Challenge Already Replaced. Refreshing The Live Ledger.'
            : 'New Challenge Ready. Refreshing The Live Ledger.'
        );
        // The receipt projection may predate a newer action in another tab.
        // Paint only a freshly read, revision-bearing dashboard snapshot.
        await loadChallenges(userId, 'silent');
        // Global wallet surfaces perform their own authoritative profile read.
        // This keeps them wired even when the profile realtime frame is lost.
        masterBus.emit('BALANCE_UPDATED', { source: 'daily_challenge_reroll', userId });
      } catch (err) {
        reportError(err, 'DailyChallengesPage.reroll_failed');
        recordDailyMissionOperation({
          userId,
          event: 'reroll_failed',
          tier: challenge.tier,
          durationMs: performance.now() - startedAt,
          itemCount: 1,
          reasonCode: dailyMissionReasonCode(err),
        });
        if (isMountedRef.current) {
          toast.error(
            'Challenge Reroll Status Could Not Be Confirmed. Refreshing Your Diamond Balance.'
          );
        }
        loadChallenges(userId, 'silent');
      } finally {
        rerollGuardRef.current.delete(challenge.id);
        economyGuardRef.current = false;
        if (isMountedRef.current) {
          setEconomyBusy(false);
          setRerollingIds((prev) => {
            const next = new Set(prev);
            next.delete(challenge.id);
            return next;
          });
        }
      }
    },
    [userId, diamondBalance, loadChallenges, toast, isMountedRef, mutationEpochRef]
  );

  const handleClaimAll = useCallback(async () => {
    if (!userId || claimAllGuardRef.current || economyGuardRef.current) return;
    claimAllGuardRef.current = true;
    economyGuardRef.current = true;

    setClaimingAll(true);
    setEconomyBusy(true);
    const startedAt = performance.now();
    let ready: TieredChallenge[] = [];
    let readyIds: string[] = [];

    try {
      // Reconcile with the authoritative vault at the instant of settlement.
      // Realtime and the cursor catch-up deliberately coalesce bursts, so
      // the rendered vault can briefly contain only the first completed row.
      // Claim All must never turn that transient view into a partial payout.
      const dashboard = await dailyChallengeService.getDashboard(userId);
      if (!isMountedRef.current) return;

      ready = dashboard.vault.items;
      if (ready.length === 0) {
        setRewardVault(dashboard.vault);
        toast.info('Those Rewards Were Already Claimed.');
        focusAfterMissionUpdate('mission-board-title');
        return;
      }

      readyIds = ready.map((challenge) => challenge.id);
      readyIds.forEach((id) => claimGuardRef.current.add(id));
      setClaimingIds((prev) => new Set([...prev, ...readyIds]));

      const paid = await dailyChallengeService.claimChallenges(userId, readyIds);
      if (!isMountedRef.current) return;

      mutationEpochRef.current += 1;
      const projectionInstalled = paid.dashboard
        ? installDashboardProjection(paid.dashboard)
        : false;
      const rewardBalance = paid.dashboard
        ? projectionInstalled
          ? paid.dashboard.diamondBalance
          : diamondBalanceRef.current
        : paid.settlementDiamondBalance;
      if (!paid.dashboard) void loadChallenges(userId, 'silent');
      const settledIds = new Set([...paid.claimedIds, ...paid.alreadyClaimedIds]);
      setChallenges((prev) =>
        prev.map((challenge) =>
          settledIds.has(challenge.id) ? { ...challenge, claimed: true } : challenge
        )
      );
      if (paid.claimedIds.length > 0) {
        capture('daily_mission_claimed', {
          tier: 'vault',
          diamond_reward: paid.diamondsCredited,
          challenge_diamonds: paid.challengeDiamonds,
          milestone_diamonds: paid.milestoneDiamonds,
          claim_count: paid.claimedIds.length,
        });
        recordDailyMissionOperation({
          userId,
          event: 'claim_all_succeeded',
          durationMs: performance.now() - startedAt,
          itemCount: paid.claimedIds.length,
        });
        const newlyClaimedIds = new Set(paid.claimedIds);
        triggerHaptic('success');
        setReward({
          name: `${paid.claimedIds.length} Challenge${paid.claimedIds.length === 1 ? '' : 's'}`,
          diamonds: paid.diamondsCredited,
          challengeDiamonds: paid.challengeDiamonds,
          milestoneDiamonds: paid.milestoneDiamonds,
          diamondBalance: rewardBalance,
          returnFocusId: 'mission-board-title',
        });
        for (const challenge of ready) {
          if (!newlyClaimedIds.has(challenge.id)) continue;
          masterBus.emit('MISSION_CLAIMED', {
            missionId: challenge.id,
            tier: challenge.tier,
            rewardType: 'diamonds',
            rewardAmount: challenge.challenge.diamondReward,
          });
        }
      } else {
        toast.info('Those Rewards Were Already Claimed.');
        focusAfterMissionUpdate('mission-board-title');
      }
    } catch (err) {
      reportError(err, 'DailyChallengesPage.claimAll_failed');
      recordDailyMissionOperation({
        userId,
        event: 'claim_all_failed',
        durationMs: performance.now() - startedAt,
        itemCount: readyIds.length,
        reasonCode: dailyMissionReasonCode(err),
      });
      toast.error('Reward Status Could Not Be Confirmed. Refreshing Your Challenge Ledger.');
      loadChallenges(userId, 'silent');
    } finally {
      readyIds.forEach((id) => claimGuardRef.current.delete(id));
      claimAllGuardRef.current = false;
      economyGuardRef.current = false;
      if (isMountedRef.current) {
        setClaimingAll(false);
        setEconomyBusy(false);
        setClaimingIds((prev) => {
          const next = new Set(prev);
          readyIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    }
  }, [
    userId,
    toast,
    installDashboardProjection,
    loadChallenges,
    isMountedRef,
    diamondBalanceRef,
    mutationEpochRef,
    setChallenges,
    setRewardVault,
  ]);

  return {
    claimingIds,
    claimingAll,
    rerollingIds,
    confirmingRerollId,
    setConfirmingRerollId,
    buyingFreeze,
    confirmingFreeze,
    setConfirmingFreeze,
    economyBusy,
    economyGuardRef,
    celebratingIds,
    reward,
    setReward,
    handleClaim,
    dismissFreezePurchase,
    handleBuyFreeze,
    handleReroll,
    handleClaimAll,
  };
}
