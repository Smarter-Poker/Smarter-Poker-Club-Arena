/**
 * MARKETPLACE — Diamonds tab: buy diamonds with real money via Stripe Checkout.
 * Same packages as the smarter.poker Diamond Store. Prices are resolved
 * server-side in /api/store/create-checkout-session — the client sends only ids.
 */

import { useState } from 'react';
import { useToast } from '../../components/common/Toast';
import { fmt } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { DiamondArt } from './ItemArt';
import { startCheckout, type DiamondPackage, type WalletInfo } from './marketplaceShared';

interface DiamondsTabProps {
  clubId: string;
  wallet: WalletInfo;
  /** package table served by /api/club-arena/store-catalog */
  packages: DiamondPackage[];
}

export default function DiamondsTab({ clubId, wallet, packages }: DiamondsTabProps) {
  const toast = useToast();
  const [redirecting, setRedirecting] = useState<string | null>(null);

  const handleBuy = async (packageId: string) => {
    if (redirecting) return;
    setRedirecting(packageId);
    try {
      await startCheckout(
        'diamonds',
        [{ packageId, quantity: 1 }],
        `club=${encodeURIComponent(clubId)}&tab=diamonds`
      );
      // Redirect happens inside startCheckout on success.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
      setRedirecting(null);
    }
  };

  return (
    <>
      <div className={styles.sectionIntro}>
        <h2 className={styles.sectionTitle}>Buy Diamonds</h2>
        <p className={styles.sectionSub}>
          Diamonds Power Everything: Club Shop Items, VIP Passes, Throwables, And Premium Features.{' '}
          {wallet.loaded ? (
            <>
              Current Balance: <strong>{fmt(wallet.diamonds)}</strong>.
            </>
          ) : (
            <>Your Current Balance Is Unavailable Right Now.</>
          )}{' '}
          Secure Payment Via Stripe - You Will Be Redirected To Checkout And Returned Here.
        </p>
      </div>

      <div className={styles.pkgGrid}>
        {packages.map((pkg, idx) => (
          <div
            key={pkg.id}
            className={`${styles.pkgCard} ${pkg.popular ? styles.pkgCardPopular : ''}`}
          >
            {pkg.popular && <span className={styles.pkgRibbon}>POPULAR</span>}
            {pkg.bonus > 0 && <span className={styles.pkgBonus}>+{fmt(pkg.bonus)} Bonus</span>}
            <div className={styles.pkgArt}>
              <DiamondArt tier={idx} />
            </div>
            <div className={styles.pkgAmount}>{fmt(pkg.diamonds)}</div>
            <div className={styles.pkgLabel}>Diamonds</div>
            <button
              className={styles.pkgBuy}
              disabled={redirecting !== null}
              onClick={() => handleBuy(pkg.id)}
            >
              {redirecting === pkg.id ? 'Opening Checkout...' : `$${pkg.priceUsd.toFixed(2)}`}
            </button>
          </div>
        ))}
      </div>

      <div className={styles.infoNote}>
        1 Diamond = $0.01. Purchases Are Credited Automatically After Payment. If Your Balance Does
        Not Update Right Away, Use Refresh - Stripe Confirmation Can Take A Few Seconds.
      </div>
    </>
  );
}
