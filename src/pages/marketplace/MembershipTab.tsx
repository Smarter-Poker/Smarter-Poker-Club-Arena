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

  const claimIntent = (key: string): boolean => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    intentKeyRef.current = uuid();
    setBusy(key);
    return true;
  };

  const releaseIntent = () => {
    inFlightRef.current = false;
    intentKeyRef.current = null;
    setBusy(null);
  };

  const buyDailyPass = async (cost: number) => {
    if (inFlightRef.current) return;
    if (!wallet.loaded) {
      toast.error('Your Diamond Balance Is Unavailable Right Now');
      return;
    }
    if (wallet.diamonds < cost) {
      toast.error(`You Need ${fmt(cost)} Diamonds For A Daily Pass`);
      return;
    }
    if (!claimIntent('vip-daily')) return;
    if (
      !(await confirmDialog({
        title: 'Daily VIP Pass',
        message: wallet.isVip
          ? `Spend ${fmt(cost)} Diamonds To Extend Your VIP Access By 24 Hours?`
          : `Spend ${fmt(cost)} Diamonds For 24 Hours Of VIP Access?`,
        confirmText: 'Activate',
        variant: 'default',
      }))
    ) {
      releaseIntent();
      return;
    }
    try {
      const data = await storeFetch<{ success: true; expiresAt?: string; newBalance?: number }>(
        '/api/store/purchase-daily-vip',
        { body: { idempotencyKey: intentKeyRef.current } }
      );
      toast.success(
        data.expiresAt ? `VIP Active Until ${formatDate(data.expiresAt)}` : 'VIP Daily Pass Active'
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'vip_daily' });
      masterBus.emit('ENTITLEMENTS_CHANGED', {
        userId,
        category: 'vip',
        source: 'vip-purchase',
      });
      onWalletChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      releaseIntent();
    }
  };

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
      releaseIntent();
    }
  };

  const buyWithDiamonds = async (planKey: 'monthly' | 'annual', priceDiamonds: number) => {
    if (inFlightRef.current) return;
    if (!wallet.loaded) {
      toast.error('Your Diamond Balance Is Unavailable Right Now');
      return;
    }
    if (wallet.diamonds < priceDiamonds) {
      toast.error(`You Need ${fmt(priceDiamonds)} Diamonds For This Plan`);
      return;
    }
    if (!claimIntent(`diamonds-${planKey}`)) return;
    if (
      !(await confirmDialog({
        title: `${planKey === 'monthly' ? 'Monthly' : 'Annual'} VIP`,
        message: `Spend ${fmt(priceDiamonds)} Diamonds For ${planKey === 'monthly' ? 'Monthly' : 'Annual'} VIP Membership?`,
        confirmText: 'Purchase',
        variant: 'default',
      }))
    ) {
      releaseIntent();
      return;
    }
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
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      releaseIntent();
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
                  plan.id === 'vip-annual'
                    ? 'annual'
                    : plan.id === 'vip-daily'
                      ? 'daily'
                      : 'monthly'
                }
              />
            </div>
            <div className={styles.planName}>{plan.name}</div>
            <div className={styles.planPrice}>
              {plan.priceUsd != null
                ? `$${plan.priceUsd.toFixed(2)}`
                : `${fmt(plan.priceDiamonds)} Diamonds`}
            </div>
            <div className={styles.planPeriod}>{plan.period}</div>
            <ul className={styles.planFeatures}>
              {plan.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {plan.id === 'vip-daily' ? (
              <button
                className={styles.btnPrimary}
                disabled={busy !== null || !wallet.loaded || wallet.diamonds < plan.priceDiamonds}
                onClick={() => buyDailyPass(plan.priceDiamonds)}
              >
                {busy === 'vip-daily'
                  ? 'Activating...'
                  : `${wallet.isVip ? 'Extend' : 'Activate'} For ${fmt(plan.priceDiamonds)} Diamonds`}
              </button>
            ) : (
              <>
                <button
                  className={styles.btnPrimary}
                  disabled={busy !== null || !plan.checkoutPlan}
                  onClick={() => plan.checkoutPlan && buyWithCard(plan.checkoutPlan)}
                >
                  {busy === `card-${plan.checkoutPlan}`
                    ? 'Opening Checkout...'
                    : wallet.isVip
                      ? 'Switch To This Plan'
                      : 'Subscribe With Card'}
                </button>
                <button
                  className={styles.btnGhostWide}
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

      <div className={styles.infoNote}>
        Card Subscriptions Renew Automatically And Can Be Canceled Anytime.{' '}
        <a className={styles.inlineLink} href="/hub/diamond-store?tab=vip">
          Manage Subscription
        </a>
        . Diamond-Paid Plans Do Not Auto-Renew.
      </div>
    </>
  );
}
