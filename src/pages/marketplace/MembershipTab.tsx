/**
 * MARKETPLACE : Membership tab: monthly, yearly, and Lifetime VIP.
 *  - Monthly/Yearly: verified Card subscription or Diamond settlement.
 *  - Lifetime: verified Diamond settlement; Card remains paused until its
 *              complete one-time charge and reversal lifecycle is available.
 * Pricing remains server-authoritative. Diamond checkout also sends the exact
 * account-bound amount the player reviewed so a reprice is refused before a
 * debit instead of silently charging different terms.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { masterBus } from '../../core/MasterBus';
import { fmt, formatDate } from '../../utils/format';
import { formatPopupText } from '../../utils/popupStyle';
import styles from '../MarketplacePage.module.css';
import {
  isVerifiedCheckoutPrecommitRefusal,
  isVerifiedCheckoutTerminalExpiration,
  isVerifiedVipPurchasePrecommitRefusal,
  marketplacePurchaseScope,
  checkoutProviderReadyForCurrentPlatform,
  isNativeMarketplaceRuntime,
  readMarketplacePurchaseIntent,
  readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent,
  startCheckout,
  storeFetch,
  subscriptionCheckoutOfferConfirmation,
  vipDiamondOfferConfirmation,
  nativePurchaseRequestFor,
  verifiedVipDiamondPurchaseReceipt,
  type StoreCatalog,
  type VipPlan,
  type WalletInfo,
} from './marketplaceShared';

// This is the established gold VIP card used by the Arena. Membership state,
// plan names, prices, and actions remain live DOM beside it; Marketplace must
// not replace it with generated term-specific frames.
const VIP_CARD_ART = `${import.meta.env.BASE_URL}images/vip-card.png`;

interface MembershipTabProps {
  clubId: string;
  userId: string;
  wallet: WalletInfo;
  /** plan table served by /api/club-arena/store-catalog */
  plans: VipPlan[];
  /** True only after the server confirms the current plan and price table. */
  catalogVerified: boolean;
  /** Bypasses the catalog TTL immediately before a payment is authorized. */
  refreshCatalogForPurchase: () => Promise<StoreCatalog>;
  onWalletChanged: () => void;
}

function vipDiamondPayloadKey(plan: VipPlan): string | null {
  if (!plan.planKey) return null;
  return JSON.stringify({
    version: 1,
    plan: plan.planKey,
    id: plan.id,
    priceDiamonds: plan.priceDiamonds,
  });
}

interface VipRecoveryDisplay {
  checked: boolean;
  pending: boolean;
  termsConflict: boolean;
}

export default function MembershipTab({
  clubId,
  userId,
  wallet,
  plans,
  catalogVerified,
  refreshCatalogForPurchase,
  onWalletChanged,
}: MembershipTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // State does not latch two events fired in one React commit. Every membership
  // path shares this ref so touch+click can create only one purchase intent.
  const inFlightRef = useRef(false);
  const activeOwnerRef = useRef({ userId, clubId });
  const paymentAttemptRef = useRef(0);
  const paymentAbortRef = useRef<AbortController | null>(null);
  const [diamondRecovery, setDiamondRecovery] = useState<Record<string, VipRecoveryDisplay>>({});

  /* The synchronous latch blocks touch+click overlap. Financial identity is
     separate and durable in sessionStorage, bound to account + plan + price,
     so a reload after a lost response still replays the same request. */
  const claimIntent = (key: string): boolean => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(key);
    return true;
  };

  const releaseIntent = () => {
    inFlightRef.current = false;
    setBusy(null);
  };

  const refreshDiamondRecovery = useCallback(() => {
    const next: Record<string, VipRecoveryDisplay> = {};
    for (const plan of plans) {
      const payloadKey = vipDiamondPayloadKey(plan);
      if (!plan.planKey || !payloadKey) {
        next[plan.id] = { checked: true, pending: false, termsConflict: false };
        continue;
      }
      try {
        next[plan.id] = {
          checked: true,
          pending: Boolean(
            readMarketplacePurchaseIntent(
              marketplacePurchaseScope(userId, 'vip-diamonds', plan.planKey),
              payloadKey
            )
          ),
          termsConflict: false,
        };
      } catch {
        next[plan.id] = { checked: true, pending: false, termsConflict: true };
      }
    }
    setDiamondRecovery(next);
  }, [plans, userId]);

  useLayoutEffect(() => {
    activeOwnerRef.current = { userId, clubId };
    paymentAttemptRef.current += 1;
    paymentAbortRef.current?.abort();
    paymentAbortRef.current = null;
    inFlightRef.current = false;
    setBusy(null);
    setDiamondRecovery({});
  }, [clubId, userId]);

  useLayoutEffect(() => {
    refreshDiamondRecovery();
  }, [refreshDiamondRecovery]);

  useEffect(
    () => () => {
      paymentAttemptRef.current += 1;
      paymentAbortRef.current?.abort();
      paymentAbortRef.current = null;
    },
    []
  );

  /* THE APP STORE BUILD (2026-09-08). Inside the Capacitor app a subscription
     is sold through StoreKit / Play Billing (startCheckout branches to
     src/lib/native/purchases.ts), and Apple 3.1.2 requires two things a web
     page never needed: a Restore Purchases button and a way to reach the
     store's own subscription management screen. Both are native-only; the
     web keeps its Stripe copy and its /hub/diamond-store link untouched. */
  const native = isNativeMarketplaceRuntime();
  const cardPaymentAvailable = checkoutProviderReadyForCurrentPlatform('subscription');

  const restorePurchases = async () => {
    if (!cardPaymentAvailable) {
      toast.error('App Store Purchase Recovery Is Temporarily Unavailable On This Build.');
      return;
    }
    if (!claimIntent('restore')) return;
    const attemptId = ++paymentAttemptRef.current;
    paymentAbortRef.current?.abort();
    const controller = new AbortController();
    paymentAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      paymentAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === userId &&
      activeOwnerRef.current.clubId === clubId;
    try {
      const { restoreNativePurchases } = await import('../../lib/native/purchases');
      const result = await restoreNativePurchases(userId);
      if (!attemptIsCurrent()) return;
      if (result.ok) {
        toast.success('Purchases Restored');
        onWalletChanged();
      } else {
        toast.error(
          result.error === 'store_not_configured'
            ? 'Purchases Are Not Set Up On This Build Yet.'
            : 'Could Not Restore Purchases.'
        );
      }
    } catch {
      if (attemptIsCurrent()) toast.error('Could Not Restore Purchases.');
    } finally {
      if (paymentAbortRef.current === controller) {
        paymentAbortRef.current = null;
        releaseIntent();
      }
    }
  };

  const manageSubscription = async () => {
    if (!cardPaymentAvailable) {
      toast.error('App Store Subscription Management Is Temporarily Unavailable On This Build.');
      return;
    }
    if (!claimIntent('manage-subscription')) return;
    const attemptId = ++paymentAttemptRef.current;
    paymentAbortRef.current?.abort();
    const controller = new AbortController();
    paymentAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      paymentAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === userId &&
      activeOwnerRef.current.clubId === clubId;
    try {
      const { openNativeSubscriptionManagement } = await import('../../lib/native/purchases');
      await openNativeSubscriptionManagement();
    } catch {
      if (attemptIsCurrent()) toast.error('Could Not Open Subscription Settings.');
    } finally {
      if (paymentAbortRef.current === controller) {
        paymentAbortRef.current = null;
        releaseIntent();
      }
    }
  };

  /*
   * A LIFETIME MEMBER CANNOT BUY MORE VIP, AND THE SERVER SAYS SO WITH A 409.
   *
   * Dan 2026-09-04: "you can't actually buy anything with diamonds anywhere,
   * you get an error message from any and all pages." His account is
   * lifetime VIP. This tab rendered "Extend For 150 Diamonds", "Pay 1,999
   * Diamonds" and "Pay 19,999 Diamonds" to him regardless, and every press
   * went to the server, which refused each one - correctly - with
   * "Lifetime VIP already includes this pass". `storeFetch` turns that into
   * a thrown error and the catch below turned it into a red toast. Three
   * buttons, three purchases that could never succeed, three errors.
   *
   * The World Hub's own store page already short-circuits this case
   * (diamond-store.js). So does this tab now: a lifetime member sees the
   * plans as included, not for sale.
   */
  const isLifetime = wallet.loaded && wallet.vipTier === 'lifetime';
  const cardCheckoutIsReady = (plan: VipPlan) =>
    wallet.loaded &&
    !isLifetime &&
    catalogVerified &&
    cardPaymentAvailable &&
    plan.cardCheckoutReady === true &&
    Boolean(plan.checkoutPlan) &&
    (!native || nativePurchaseRequestFor('subscription', [{ plan: plan.checkoutPlan }]) !== null);

  /* The three terms, spelled for a player. Dan 2026-09-05: "just vip, monthly,
     yearly or lifetime". */
  const TERM_LABEL: Record<'monthly' | 'yearly' | 'lifetime', string> = {
    monthly: 'Monthly',
    yearly: 'Yearly',
    lifetime: 'Lifetime',
  };

  /* REMOVED 2026-09-05 with the Daily Pass. Dan: "just vip, monthly, yearly
     or lifetime". It called /api/store/purchase-daily-vip, which is deleted -
     nothing was ever sold on it (0 'vip_daily' diamond transactions, 0
     purchases carrying that redemption intent), so no receipt depends on it. */

  const buyWithCard = async (plan: VipPlan) => {
    if (!wallet.loaded) {
      toast.error('Your Membership Status Is Unavailable Right Now');
      return;
    }
    if (isLifetime) {
      toast.info('Lifetime VIP Already Includes Every Plan');
      return;
    }
    if (!catalogVerified) {
      toast.error('Live Pricing Is Temporarily Unavailable');
      return;
    }
    if (!cardCheckoutIsReady(plan)) {
      toast.error('Card Checkout Is Not Available For This Plan On This Device');
      return;
    }
    if (!claimIntent(`card-${plan.id}`)) return;
    let purchaseScope: string | null = null;
    let purchaseRequestId: string | null = null;
    let purchaseWasResumed = false;
    const attemptId = ++paymentAttemptRef.current;
    paymentAbortRef.current?.abort();
    const controller = new AbortController();
    paymentAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      paymentAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === userId &&
      activeOwnerRef.current.clubId === clubId;
    try {
      const currentCatalog = await refreshCatalogForPurchase();
      if (!attemptIsCurrent()) return;
      const currentPlan = currentCatalog.vipPlans.find((entry) => entry.id === plan.id);
      if (
        !currentCatalog.fromServer ||
        !currentPlan ||
        !currentPlan.cardCheckoutReady ||
        !currentPlan.checkoutPlan ||
        (native &&
          nativePurchaseRequestFor('subscription', [{ plan: currentPlan.checkoutPlan }]) === null)
      ) {
        throw new Error('Card Checkout Could Not Be Verified. No Payment Was Started.');
      }
      if (
        currentPlan.checkoutPlan !== plan.checkoutPlan ||
        currentPlan.priceUsd !== plan.priceUsd ||
        currentPlan.priceDiamonds !== plan.priceDiamonds
      ) {
        throw new Error('Pricing Was Updated. Review The Current Plan Before Purchasing.');
      }
      const offerConfirmation = subscriptionCheckoutOfferConfirmation(userId, currentPlan);
      if (!offerConfirmation) {
        throw new Error('The Checkout Terms Could Not Be Verified. No Payment Was Started.');
      }
      purchaseScope = marketplacePurchaseScope(userId, 'vip-card', currentPlan.id);
      const purchaseIntent = readOrCreateMarketplacePurchaseIntent(
        purchaseScope,
        JSON.stringify({
          version: 1,
          type: 'subscription',
          id: currentPlan.id,
          plan: currentPlan.checkoutPlan,
          priceUsd: currentPlan.priceUsd,
          priceDiamonds: currentPlan.priceDiamonds,
        })
      );
      purchaseRequestId = purchaseIntent.requestId;
      purchaseWasResumed = purchaseIntent.resumed;
      await startCheckout(
        'subscription',
        [{ plan: currentPlan.checkoutPlan }],
        `club=${encodeURIComponent(clubId)}&tab=membership`,
        {
          requestId: purchaseIntent.requestId,
          expectedUserId: userId,
          offerConfirmation,
          signal: controller.signal,
        }
      );
    } catch (err: unknown) {
      if (!attemptIsCurrent()) return;
      if (
        purchaseScope &&
        purchaseRequestId &&
        (isVerifiedCheckoutTerminalExpiration(err) ||
          (!purchaseWasResumed && isVerifiedCheckoutPrecommitRefusal(err)))
      ) {
        if (!retireMarketplacePurchaseIntent(purchaseScope, purchaseRequestId)) {
          toast.warning(
            'Checkout Did Not Start, But Its Protected Recovery Record Changed And Was Not Cleared. Review The Pending Purchase Before Trying Again.'
          );
        }
      }
      toast.error(err instanceof Error ? err.message : 'Could Not Start Checkout');
    } finally {
      if (paymentAbortRef.current === controller) {
        paymentAbortRef.current = null;
        // Native StoreKit/Play success and cancellation stay inside the SPA.
        // Always release the synchronous latch after the sheet resolves.
        releaseIntent();
      }
    }
  };

  const buyWithDiamonds = async (plan: VipPlan) => {
    const planKey = plan.planKey;
    if (!planKey) return;
    if (inFlightRef.current) return;
    if (!catalogVerified) {
      toast.error('Live Pricing Is Temporarily Unavailable');
      return;
    }
    if (!claimIntent(`diamonds-${planKey}`)) return;
    let purchaseScope: string | null = null;
    let purchaseRequestId: string | null = null;
    let purchaseWasResumed = false;
    const attemptId = ++paymentAttemptRef.current;
    paymentAbortRef.current?.abort();
    const controller = new AbortController();
    paymentAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      paymentAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === userId &&
      activeOwnerRef.current.clubId === clubId;
    try {
      const currentCatalog = await refreshCatalogForPurchase();
      if (!attemptIsCurrent()) return;
      const currentPlan = currentCatalog.vipPlans.find((entry) => entry.planKey === planKey);
      if (!currentCatalog.fromServer || !currentPlan || !currentPlan.diamondCheckoutReady) {
        throw new Error('Diamond Checkout Could Not Be Verified. No Purchase Was Started.');
      }
      if (currentPlan.id !== plan.id || currentPlan.priceDiamonds !== plan.priceDiamonds) {
        throw new Error('Pricing Was Updated. Review The Current Plan Before Purchasing.');
      }
      purchaseScope = marketplacePurchaseScope(userId, 'vip-diamonds', planKey);
      const payloadKey = vipDiamondPayloadKey(currentPlan);
      if (!payloadKey) {
        throw new Error('The VIP Purchase Terms Could Not Be Verified.');
      }
      const pendingIntent = readMarketplacePurchaseIntent(purchaseScope, payloadKey);
      if (isLifetime && !pendingIntent) {
        toast.info('Lifetime VIP Already Includes Every Plan');
        return;
      }
      if (!pendingIntent && !wallet.loaded) {
        throw new Error('Your Diamond Balance Is Unavailable Right Now');
      }
      if (!pendingIntent && wallet.diamonds < currentPlan.priceDiamonds) {
        throw new Error(`You Need ${fmt(currentPlan.priceDiamonds)} Diamonds For This Plan`);
      }
      const confirmed = await confirmDialog({
        title: pendingIntent ? 'Verify Pending VIP Purchase' : `${TERM_LABEL[planKey]} VIP`,
        message: pendingIntent
          ? `Verify The Earlier ${TERM_LABEL[planKey]} VIP Purchase At ${fmt(currentPlan.priceDiamonds)} Diamonds Before Starting Another Purchase?`
          : planKey === 'lifetime'
            ? `Spend ${fmt(currentPlan.priceDiamonds)} Diamonds For Lifetime VIP? Your Membership Stops Having An Expiry Date Rather Than Getting A Longer One, And It Never Renews.`
            : `Spend ${fmt(currentPlan.priceDiamonds)} Diamonds For ${TERM_LABEL[planKey]} VIP Membership?`,
        confirmText: pendingIntent ? 'Verify Purchase' : 'Purchase',
        variant: 'default',
      });
      if (!attemptIsCurrent()) return;
      if (!confirmed) {
        return;
      }
      const purchaseIntent =
        pendingIntent || readOrCreateMarketplacePurchaseIntent(purchaseScope, payloadKey);
      purchaseRequestId = purchaseIntent.requestId;
      purchaseWasResumed = purchaseIntent.resumed;
      const offerConfirmation = vipDiamondOfferConfirmation(userId, currentPlan);
      if (!offerConfirmation) {
        throw new Error('The Reviewed VIP Terms Could Not Be Verified. Review This Plan Again.');
      }
      const response = await storeFetch<unknown>('/api/store/purchase-vip-with-diamonds', {
        body: {
          plan: planKey,
          offerConfirmation,
          idempotencyKey: purchaseIntent.requestId,
        },
        idempotencyKey: purchaseIntent.requestId,
        expectedUserId: userId,
        signal: controller.signal,
      });
      if (!attemptIsCurrent()) return;
      const receipt = verifiedVipDiamondPurchaseReceipt(response, {
        accountId: userId,
        requestId: purchaseIntent.requestId,
        plan: planKey,
        cost: currentPlan.priceDiamonds,
      });
      if (!receipt) {
        throw new Error(
          'The VIP Purchase Returned An Unverified Receipt. The Same Protected Request Will Be Used To Verify It.'
        );
      }
      const recoveryRetired = retireMarketplacePurchaseIntent(
        purchaseScope,
        purchaseIntent.requestId
      );
      const historicalReplay =
        receipt.idempotent &&
        receipt.expiresAt !== null &&
        Date.parse(receipt.expiresAt) <= Date.now();
      if (recoveryRetired) {
        toast.success(
          historicalReplay
            ? 'Previous VIP Purchase Verified'
            : receipt.idempotent
              ? 'VIP Membership Verified'
              : 'VIP Membership Activated'
        );
      } else {
        toast.warning(
          'VIP Was Applied And Your Balance Was Updated, But Secure Purchase Recovery Could Not Be Cleared. Do Not Submit This Purchase Again.'
        );
      }
      masterBus.emit('BALANCE_UPDATED', { source: 'vip_purchase' });
      masterBus.emit('ENTITLEMENTS_CHANGED', {
        userId,
        category: 'vip',
        source: 'vip-purchase',
      });
      onWalletChanged();
    } catch (err: unknown) {
      if (!attemptIsCurrent()) return;
      if (
        purchaseScope &&
        purchaseRequestId &&
        !purchaseWasResumed &&
        isVerifiedVipPurchasePrecommitRefusal(err, {
          accountId: userId,
          requestId: purchaseRequestId,
        })
      ) {
        const recoveryRetired = retireMarketplacePurchaseIntent(purchaseScope, purchaseRequestId);
        if (!recoveryRetired) {
          toast.warning(
            'The Purchase Was Refused, But Its Protected Recovery Record Changed And Was Not Cleared. Verify It Before Trying Again.'
          );
        }
      }
      toast.error(err instanceof Error ? err.message : 'Purchase Failed');
    } finally {
      if (paymentAbortRef.current === controller) {
        paymentAbortRef.current = null;
        refreshDiamondRecovery();
        releaseIntent();
      }
    }
  };

  return (
    <>
      <div className={styles.sectionIntro}>
        <h2 className={styles.sectionTitle}>VIP Membership</h2>
        <p className={styles.sectionSub}>
          VIP Unlocks Rabbit Hunt, Stack In Big Blinds, Offline Protection, Auto Time Bank,
          Throwables, And Daily Diamond Bonuses Across Smarter.Poker And Club Arena.
        </p>
      </div>

      {!catalogVerified && (
        <div className={styles.infoNote} role="alert">
          Live Pricing Is Temporarily Unavailable. Plans Are Display Only Until Verification
          Returns.
        </div>
      )}

      {/* Current status */}
      <div
        className={
          wallet.loaded && wallet.isVip ? styles.vipStatusActive : styles.vipStatusInactive
        }
      >
        {!wallet.loaded ? (
          <span role="alert">
            Membership Status Is Temporarily Unavailable. Purchases Stay Paused Until Verification
            Returns.
          </span>
        ) : wallet.isVip ? (
          <>
            <span className={styles.vipStatusBadge}>VIP Active</span>
            <span>
              {wallet.vipTier === 'lifetime'
                ? 'Lifetime Membership'
                : wallet.vipExpiresAt
                  ? `${wallet.vipTier ? `${wallet.vipTier.charAt(0).toUpperCase()}${wallet.vipTier.slice(1)} Plan, ` : ''}Expires ${formatDate(wallet.vipExpiresAt)}`
                  : 'Active Membership'}
            </span>
          </>
        ) : (
          <span>You Are Not A VIP Member Yet. Pick A Plan Below.</span>
        )}
      </div>

      <div className={styles.planGrid}>
        {plans.map((plan) => {
          const recovery = diamondRecovery[plan.id] ?? {
            checked: false,
            pending: false,
            termsConflict: false,
          };
          const pendingDiamondPurchase = recovery.pending;
          const pendingTermsConflict = recovery.termsConflict;
          const diamondActionDisabled =
            busy !== null ||
            !catalogVerified ||
            !plan.diamondCheckoutReady ||
            !recovery.checked ||
            pendingTermsConflict ||
            (!pendingDiamondPurchase && (!wallet.loaded || wallet.diamonds < plan.priceDiamonds));

          return (
            <div
              key={plan.id}
              className={`${styles.planCard} ${plan.featured ? styles.planCardFeatured : ''}`}
            >
              {plan.featured && <span className={styles.pkgRibbon}>Most Popular</span>}
              <div className={styles.planArt}>
                <img
                  className={styles.planArtImage}
                  src={VIP_CARD_ART}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  decoding="async"
                />
              </div>
              <div className={styles.planName}>{formatPopupText(plan.name)}</div>
              <div className={styles.planPrice}>
                {/* Every term is priced in USD; the Diamond figure uses the same
                    100-per-dollar conversion. A term shows USD only when the
                    server marks its complete Card lifecycle ready. */}
                {cardCheckoutIsReady(plan)
                  ? `$${(plan.priceUsd ?? 0).toFixed(2)}`
                  : `${fmt(plan.priceDiamonds)} Diamonds`}
              </div>
              <div className={styles.planPeriod}>{formatPopupText(plan.period)}</div>
              <ul className={styles.planFeatures}>
                {plan.features.map((f) => (
                  <li key={f}>{formatPopupText(f)}</li>
                ))}
              </ul>
              {isLifetime &&
              recovery.checked &&
              !pendingDiamondPurchase &&
              !pendingTermsConflict ? (
                <button className={styles.btnGhostWide} disabled aria-disabled="true">
                  Included With Lifetime VIP
                </button>
              ) : (
                <>
                  {/* A dormant server plan id is not a sale capability. Keep the
                      button hidden until the catalog confirms the complete Card
                      charge, grant, refund and dispute lifecycle is ready. */}
                  {cardCheckoutIsReady(plan) && (
                    <button
                      className={styles.btnPrimary}
                      disabled={busy !== null}
                      onClick={() => buyWithCard(plan)}
                      aria-label={`${wallet.isVip ? 'Switch To' : 'Subscribe To'} ${formatPopupText(plan.name)} With Card`}
                    >
                      {busy === `card-${plan.id}`
                        ? native
                          ? 'Opening Store'
                          : 'Opening Checkout'
                        : wallet.isVip
                          ? 'Switch To This Plan'
                          : native
                            ? 'Subscribe'
                            : 'Subscribe With Card'}
                    </button>
                  )}
                  <button
                    className={cardCheckoutIsReady(plan) ? styles.btnGhostWide : styles.btnPrimary}
                    disabled={diamondActionDisabled}
                    onClick={() => buyWithDiamonds(plan)}
                    aria-label={
                      pendingDiamondPurchase
                        ? `Verify Pending ${formatPopupText(plan.name)} Purchase`
                        : `Pay ${fmt(plan.priceDiamonds)} Diamonds For ${formatPopupText(plan.name)}`
                    }
                  >
                    {busy === `diamonds-${plan.planKey}`
                      ? 'Processing'
                      : !recovery.checked
                        ? 'Checking Protected Purchase'
                        : pendingTermsConflict
                          ? 'Pending Purchase Needs Review'
                          : pendingDiamondPurchase
                            ? 'Verify Purchase'
                            : catalogVerified && plan.diamondCheckoutReady
                              ? `Pay ${fmt(plan.priceDiamonds)} Diamonds`
                              : 'Live Pricing Unavailable'}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {native ? (
        <div className={styles.infoNote}>
          Subscriptions Renew Automatically Through Your App Store Account And Can Be Canceled
          Anytime.{' '}
          <button
            type="button"
            className={styles.inlineLink}
            disabled={busy !== null || !cardPaymentAvailable}
            onClick={manageSubscription}
          >
            {busy === 'manage-subscription' ? 'Opening Settings' : 'Manage Subscription'}
          </button>
          {' Or '}
          <button
            type="button"
            className={styles.inlineLink}
            disabled={busy !== null || !cardPaymentAvailable}
            onClick={restorePurchases}
          >
            {busy === 'restore' ? 'Restoring' : 'Restore Purchases'}
          </button>
          . Diamond-Paid Plans Do Not Auto-Renew, And Lifetime Never Does.
          {!cardPaymentAvailable &&
            ' App Store Checkout And Recovery Stay Paused Until Provider Verification Is Available.'}
        </div>
      ) : (
        <div className={styles.infoNote}>
          Card Subscriptions Renew Automatically And Can Be Canceled Anytime.{' '}
          <a className={styles.inlineLink} href="/hub/diamond-store?tab=vip">
            Manage Subscription
          </a>
          . Diamond-Paid Plans Do Not Auto-Renew, And Lifetime Never Does.
        </div>
      )}
    </>
  );
}
