/**
 * MARKETPLACE — Get Chips tab: convert diamonds to club chips.
 * Server-authoritative via /api/club-arena/purchase-chips (client sends only packageId).
 */

import { useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { fmt } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { CHIP_PACKAGES, type WalletInfo } from './marketplaceShared';

interface ChipsTabProps {
  wallet: WalletInfo;
  onGoDiamonds: () => void;
  onPurchased: () => void;
}

export default function ChipsTab({ wallet, onGoDiamonds, onPurchased }: ChipsTabProps) {
  const toast = useToast();
  const [purchasing, setPurchasing] = useState<string | null>(null);

  const handleBuy = async (pkgId: string, chips: number, diamonds: number) => {
    if (purchasing) return;
    if (wallet.diamonds < diamonds) {
      toast.error('Insufficient diamonds');
      return;
    }
    setPurchasing(pkgId);
    try {
      await callClubArenaApi('purchase-chips', { packageId: pkgId });
      toast.success(`${fmt(chips)} chips added to your wallet`);
      masterBus.emit('BALANCE_UPDATED', { source: 'chip_purchase' });
      onPurchased();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Purchase failed');
    } finally {
      setPurchasing(null);
    }
  };

  return (
    <>
      <div className={styles.sectionIntro}>
        <h2 className={styles.sectionTitle}>Get Chips</h2>
        <p className={styles.sectionSub}>
          Convert diamonds into chips for club games and shop purchases. You have{' '}
          <strong>{fmt(wallet.diamonds)}</strong> diamonds.
        </p>
      </div>

      <div className={styles.pkgGrid}>
        {CHIP_PACKAGES.map((pkg) => {
          const affordable = wallet.diamonds >= pkg.diamonds;
          return (
            <div
              key={pkg.id}
              className={`${styles.pkgCard} ${pkg.popular ? styles.pkgCardPopular : ''}`}
            >
              {pkg.popular && <span className={styles.pkgRibbon}>BEST VALUE</span>}
              {pkg.bonus ? <span className={styles.pkgBonus}>+{pkg.bonus}% bonus</span> : null}
              <div className={styles.pkgAmount}>{fmt(pkg.chips)}</div>
              <div className={styles.pkgLabel}>chips</div>
              <button
                className={styles.pkgBuy}
                disabled={purchasing !== null || !affordable}
                onClick={() => handleBuy(pkg.id, pkg.chips, pkg.diamonds)}
              >
                {purchasing === pkg.id ? 'Processing...' : `${fmt(pkg.diamonds)} diamonds`}
              </button>
            </div>
          );
        })}
      </div>

      <div className={styles.crossSell}>
        <span>Need more diamonds?</span>
        <button className={styles.inlineLink} onClick={onGoDiamonds}>
          Buy Diamonds
        </button>
      </div>
    </>
  );
}
