/**
 * MARKETPLACE — Membership tab: VIP passes and subscriptions.
 *  - Daily Pass:      150 diamonds -> /api/store/purchase-daily-vip
 *  - Monthly/Annual:  Stripe subscription via create-checkout-session, or
 *                     pay with diamonds via /api/store/purchase-vip-with-diamonds
 * All pricing is server-authoritative; the client sends only plan keys.
 */

import { useRef, useState } from 'react';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { masterBus } from '../../core/MasterBus';
import { isNativePlatform } from '../../lib/appBase';
import { fmt, formatDate } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { VipArt } from './ItemArt';
import {
  startCheckout,
  storeFetch,
  uuid,
  type VipPlan,
  type WalletInfo,
} from './marketplaceShared';

interface MembershipTabProps {
  clubId: string;
  userId: string;
  wallet: WalletInfo;
  /** plan table served by /api/club-arena/store-catalog */
  plans: VipPlan[];
  onWalletChanged: () => void;
}

export default function MembershipTab({
  clubId,
  userId,
  wallet,
  plans,
  onWalletChanged,
}: MembershipTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // State does not latch two events fired in one React commit. Every membership
  // path shares this ref so touch+click can create only one purchase intent.
  const inFlightRef = useRef(false);
  const intentKeyRef = useRef<string | null>(null);

  /* ONE KEY PER PURCHASE, HELD ACROSS RETRIES (2026-09-09).
     This minted a fresh uuid on every claim and destroyed it in `finally`,
     so a committed purchase whose response was lost - the exact case an
     idempotency key exists for - charged the player again on the next tap.
     Lifetime VIP is 19,999 diamonds. `inFlightRef` only ever blocked
     OVERLAPPING taps, never the sequential retry.
     The key is now keyed to WHAT is being bought: the same plan keeps its
     key until that purchase succeeds (or is terminally refused), and a
     different plan gets its own. Same shape as `bustRebuyKeyRef` on the
     table, which discriminates on a settled, user-chosen value. */
  const intentPlanRef = useRef<string | null>(null);
  const claimIntent = (key: string): boolean => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    if (intentPlanRef.current !== key || !intentKeyRef.current) {
      intentPlanRef.current = key;
      intentKeyRef.current = uuid();
    }
    setBusy(key);
    return true;
  };

  /** Release the in-flight latch. `spent` retires the key: the purchase
   *  either succeeded or was refused terminally, so the next press is a new
   *  purchase. An ambiguous failure keeps it, and the server replays. */
  const releaseIntent = (spent = false) => {
    inFlightRef.current = false;
    if (spent) {
      intentKeyRef.current = null;
      intentPlanRef.current = null;
    }
    setBusy(null);
  };

  /* THE APP STORE BUILD (2026-09-08). Inside the Capacitor app a subscription
     is sold through StoreKit / Play Billing (startCheckout branches to
     src/lib/native/purchases.ts), and Apple 3.1.2 requires two things a web
     page never needed: a Restore Purchases button and a way to reach the
     store's own subscription management screen. Both are native-only; the
     web keeps its Stripe copy and its /hub/diamond-store link untouched. */
  const native = isNativePlatform();

  const restorePurchases = async () => {
    if (!claimIntent('restore')) return;
    try {
      const { restoreNativePurchases } = await import('../../lib/native/purchases');
      const result = await restoreNativePurchases(userId);
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
      toast.error('Could Not Restore Purchases.');
    } finally {
      releaseIntent(true);
    }
  };

  const manageSubscription = async () => {
    try {
      const { openNativeSubscriptionManagement } = await import('../../lib/native/purchases');
      await openNativeSubscriptionManagement();
    } catch {
      toast.error('Could Not Open Subscription Settings.');
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

  const buyWithCard = async (checkoutPlan: string) => {
    if (!claimIntent(`card-${checkoutPlan}`)) return;
    try {
      await startCheckout(
        'subscription',
        [{ plan: checkoutPlan }],
        `club=${encodeURIComponent(clubId)}&tab=membership`,
        intentKeyRef.current || undefined
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
      // The hosted checkout never opened, so the key was never presented.
      releaseIntent(true);
    }
  };

  const buyWithDiamonds = async (
    planKey: 'monthly' | 'yearly' | 'lifetime',
    priceDiamonds: number
  ) => {
    if (inFlightRef.current) return;
    if (!wallet.loaded) {
      toast.error('Your Diamond Balance Is Unavailable Right Now');
      return;
    }
    if (isLifetime) {
      toast.info('Lifetime VIP Already Includes Every Plan');
      return;
    }
    if (wallet.diamonds < priceDiamonds) {
      toast.error(`You Need ${fmt(priceDiamonds)} Diamonds For This Plan`);
      return;
    }
    if (!claimIntent(`diamonds-${planKey}`)) return;
    if (
      !(await confirmDialog({
        title: `${TERM_LABEL[planKey]} VIP`,
        message:
          planKey === 'lifetime'
            ? `Spend ${fmt(priceDiamonds)} Diamonds For Lifetime VIP? Your Membership Stops Having An Expiry Date Rather Than Getting A Longer One, And It Never Renews.`
            : `Spend ${fmt(priceDiamonds)} Diamonds For ${TERM_LABEL[planKey]} VIP Membership?`,
        confirmText: 'Purchase',
        variant: 'default',
      }))
    ) {
      // Declined at the confirm dialog: nothing was sent, so nothing is spent.
      releaseIntent(true);
      return;
    }
    let spent = false;
    try {
      await storeFetch('/api/store/purchase-vip-with-diamonds', {
        body: { plan: planKey, idempotencyKey: intentKeyRef.current },
      });
      toast.success('VIP Membership Activated');
      masterBus.emit('BALANCE_UPDATED', { source: 'vip_purchase' });
      masterBus.emit('ENTITLEMENTS_CHANGED', {
        userId,
        category: 'vip',
        source: 'vip-purchase',
      });
      onWalletChanged();
      spent = true;
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
      /* Keep the key unless the server gave a terminal answer. A transport
         failure or a 5xx may be a purchase that COMMITTED and lost its
         response; presenting the same key again is what makes the second tap
         a replay instead of a second charge. */
      spent = (err as { definitive?: boolean })?.definitive === true;
    } finally {
      releaseIntent(spent);
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

      {/* Current status */}
      <div className={wallet.isVip ? styles.vipStatusActive : styles.vipStatusInactive}>
        {wallet.isVip ? (
          <>
            <span className={styles.vipStatusBadge}>VIP ACTIVE</span>
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
        {plans.map((plan) => (
          <div
            key={plan.id}
            className={`${styles.planCard} ${plan.featured ? styles.planCardFeatured : ''}`}
          >
            {plan.featured && <span className={styles.pkgRibbon}>MOST POPULAR</span>}
            <div className={styles.planArt}>
              <VipArt
                variant={
                  plan.id === 'vip-lifetime'
                    ? 'lifetime'
                    : plan.id === 'vip-yearly'
                      ? 'yearly'
                      : 'monthly'
                }
              />
            </div>
            <div className={styles.planName}>{plan.name}</div>
            <div className={styles.planPrice}>
              {/* Every term is priced in USD now; the diamond figure is the
                  same number at 100 per dollar, and for Lifetime it is
                  currently the ONLY way to pay - its one-time card checkout is
                  not built yet, which is why `checkoutPlan` is null on it. */}
              {plan.checkoutPlan
                ? `$${(plan.priceUsd ?? 0).toFixed(2)}`
                : `${fmt(plan.priceDiamonds)} Diamonds`}
            </div>
            <div className={styles.planPeriod}>{plan.period}</div>
            <ul className={styles.planFeatures}>
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {isLifetime ? (
              <button className={styles.btnGhostWide} disabled aria-disabled="true">
                Included With Lifetime VIP
              </button>
            ) : (
              <>
                {/* No card button for a term the checkout would refuse. A
                    lifetime purchase is one payment, and the World Hub's
                    session builder has no one-time VIP mode and its webhook no
                    one-time VIP grant - a session would be paid and grant
                    nothing. `checkoutPlan` is null on that plan for exactly
                    this reason; when the card path ships it stops being null
                    and this button appears with no further change here. */}
                {plan.checkoutPlan && (
                  <button
                    className={styles.btnPrimary}
                    disabled={busy !== null}
                    onClick={() => buyWithCard(plan.checkoutPlan as string)}
                  >
                    {busy === `card-${plan.checkoutPlan}`
                      ? native
                        ? 'Opening Store...'
                        : 'Opening Checkout...'
                      : wallet.isVip
                        ? 'Switch To This Plan'
                        : native
                          ? 'Subscribe'
                          : 'Subscribe With Card'}
                  </button>
                )}
                <button
                  className={plan.checkoutPlan ? styles.btnGhostWide : styles.btnPrimary}
                  disabled={busy !== null || !wallet.loaded || wallet.diamonds < plan.priceDiamonds}
                  onClick={() => plan.planKey && buyWithDiamonds(plan.planKey, plan.priceDiamonds)}
                >
                  {busy === `diamonds-${plan.planKey}`
                    ? 'Processing...'
                    : `Pay ${fmt(plan.priceDiamonds)} Diamonds`}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {native ? (
        <div className={styles.infoNote}>
          Subscriptions Renew Automatically Through Your App Store Account And Can Be Canceled
          Anytime.{' '}
          <button type="button" className={styles.inlineLink} onClick={manageSubscription}>
            Manage Subscription
          </button>
          {' Or '}
          <button
            type="button"
            className={styles.inlineLink}
            disabled={busy !== null}
            onClick={restorePurchases}
          >
            {busy === 'restore' ? 'Restoring...' : 'Restore Purchases'}
          </button>
          . Diamond-Paid Plans Do Not Auto-Renew, And Lifetime Never Does.
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
