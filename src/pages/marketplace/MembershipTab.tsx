/**
 * MARKETPLACE — Membership tab: VIP passes and subscriptions.
 *  - Daily Pass:      150 diamonds -> /api/store/purchase-daily-vip
 *  - Monthly/Annual:  Stripe subscription via create-checkout-session, or
 *                     pay with diamonds via /api/store/purchase-vip-with-diamonds
 * All pricing is server-authoritative; the client sends only plan keys.
 */

import { useState } from 'react';
import { useToast } from '../../components/common/Toast';
import { confirmDialog } from '../../components/common/confirmDialog';
import { masterBus } from '../../core/MasterBus';
import { fmt, formatDate } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { VIP_PLANS, startCheckout, storeFetch, type WalletInfo } from './marketplaceShared';

interface MembershipTabProps {
  clubId: string;
  wallet: WalletInfo;
  onWalletChanged: () => void;
}

export default function MembershipTab({ clubId, wallet, onWalletChanged }: MembershipTabProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const buyDailyPass = async () => {
    if (busy) return;
    if (wallet.diamonds < 150) {
      toast.error('You need 150 diamonds for a Daily Pass');
      return;
    }
    if (
      !(await confirmDialog({
        title: 'Daily VIP Pass',
        message: 'Spend 150 diamonds for 24 hours of VIP access?',
        confirmText: 'Activate',
        variant: 'default',
      }))
    )
      return;
    setBusy('vip-daily');
    try {
      const data = await storeFetch<{ success: true; expiresAt?: string; newBalance?: number }>(
        '/api/store/purchase-daily-vip',
        { body: { idempotencyKey: crypto.randomUUID() } }
      );
      toast.success(
        data.expiresAt ? `VIP active until ${formatDate(data.expiresAt)}` : 'VIP Daily Pass active'
      );
      masterBus.emit('BALANCE_UPDATED', { source: 'vip_daily' });
      onWalletChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBusy(null);
    }
  };

  const buyWithCard = async (checkoutPlan: string) => {
    if (busy) return;
    setBusy(`card-${checkoutPlan}`);
    try {
      await startCheckout(
        'subscription',
        [{ plan: checkoutPlan }],
        `club=${encodeURIComponent(clubId)}&tab=membership`
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
      setBusy(null);
    }
  };

  const buyWithDiamonds = async (planKey: 'monthly' | 'annual', priceDiamonds: number) => {
    if (busy) return;
    if (wallet.diamonds < priceDiamonds) {
      toast.error(`You need ${fmt(priceDiamonds)} diamonds for this plan`);
      return;
    }
    if (
      !(await confirmDialog({
        title: `${planKey === 'monthly' ? 'Monthly' : 'Annual'} VIP`,
        message: `Spend ${fmt(priceDiamonds)} diamonds for ${planKey} VIP membership?`,
        confirmText: 'Purchase',
        variant: 'default',
      }))
    )
      return;
    setBusy(`diamonds-${planKey}`);
    try {
      await storeFetch('/api/store/purchase-vip-with-diamonds', {
        body: { plan: planKey, idempotencyKey: crypto.randomUUID() },
      });
      toast.success('VIP membership activated');
      masterBus.emit('BALANCE_UPDATED', { source: 'vip_purchase' });
      onWalletChanged();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className={styles.sectionIntro}>
        <h2 className={styles.sectionTitle}>VIP Membership</h2>
        <p className={styles.sectionSub}>
          VIP unlocks rabbit hunt, stack in big blinds, offline protection, auto time bank,
          throwables, and daily diamond bonuses across Smarter.Poker and Club Arena.
        </p>
      </div>

      {/* Current status */}
      <div className={wallet.isVip ? styles.vipStatusActive : styles.vipStatusInactive}>
        {wallet.isVip ? (
          <>
            <span className={styles.vipStatusBadge}>VIP ACTIVE</span>
            <span>
              {wallet.vipTier === 'lifetime'
                ? 'Lifetime membership'
                : wallet.vipExpiresAt
                  ? `${wallet.vipTier ? `${wallet.vipTier} plan, ` : ''}expires ${formatDate(wallet.vipExpiresAt)}`
                  : 'Active membership'}
            </span>
          </>
        ) : (
          <span>You are not a VIP member yet. Pick a plan below.</span>
        )}
      </div>

      <div className={styles.planGrid}>
        {VIP_PLANS.map((plan) => (
          <div
            key={plan.id}
            className={`${styles.planCard} ${plan.featured ? styles.planCardFeatured : ''}`}
          >
            {plan.featured && <span className={styles.pkgRibbon}>MOST POPULAR</span>}
            <div className={styles.planName}>{plan.name}</div>
            <div className={styles.planPrice}>
              {plan.priceUsd != null ? `$${plan.priceUsd.toFixed(2)}` : `${fmt(plan.priceDiamonds)} diamonds`}
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
                disabled={busy !== null || wallet.diamonds < plan.priceDiamonds}
                onClick={buyDailyPass}
              >
                {busy === 'vip-daily' ? 'Activating...' : `Activate for ${fmt(plan.priceDiamonds)} diamonds`}
              </button>
            ) : (
              <>
                <button
                  className={styles.btnPrimary}
                  disabled={busy !== null}
                  onClick={() => plan.checkoutPlan && buyWithCard(plan.checkoutPlan)}
                >
                  {busy === `card-${plan.checkoutPlan}` ? 'Opening checkout...' : 'Subscribe with card'}
                </button>
                <button
                  className={styles.btnGhostWide}
                  disabled={busy !== null || wallet.diamonds < plan.priceDiamonds}
                  onClick={() => plan.planKey && buyWithDiamonds(plan.planKey, plan.priceDiamonds)}
                >
                  {busy === `diamonds-${plan.planKey}`
                    ? 'Processing...'
                    : `Pay ${fmt(plan.priceDiamonds)} diamonds`}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className={styles.infoNote}>
        Card subscriptions renew automatically and can be canceled anytime from the Diamond Store.
        Diamond-paid plans do not auto-renew.
      </div>
    </>
  );
}
