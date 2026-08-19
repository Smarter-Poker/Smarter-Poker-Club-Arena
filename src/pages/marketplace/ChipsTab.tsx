/**
 * MARKETPLACE — Get Chips tab: convert diamonds to club chips.
 * Server-authoritative via /api/club-arena/purchase-chips (client sends only
 * packageId + the club the chips are for -- never an amount or a price).
 *
 * 2026-08-19: chips are PER-CLUB (club_members.chip_balance). Passing clubId
 * routes the credit to the club whose shop you are standing in; without it the
 * server credits the global player wallet, which the shop cannot spend.
 */

import { useState } from 'react';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useToast } from '../../components/common/Toast';
import { masterBus } from '../../core/MasterBus';
import { fmt } from '../../utils/format';
import styles from '../MarketplacePage.module.css';
import { type ChipPackage, type WalletInfo } from './marketplaceShared';

interface ChipsTabProps {
  wallet: WalletInfo;
  clubId: string | null;
  /** package table served by /api/club-arena/store-catalog */
  packages: ChipPackage[];
  onGoDiamonds: () => void;
  onPurchased: () => void;
}

export default function ChipsTab({
  wallet,
  clubId,
  packages,
  onGoDiamonds,
  onPurchased,
}: ChipsTabProps) {
  const toast = useToast();
  const [purchasing, setPurchasing] = useState<string | null>(null);

  const handleBuy = async (pkgId: string, chips: number, diamonds: number) => {
    if (purchasing) return;
    if (wallet.diamonds < diamonds) {
      toast.error('Insufficient diamonds');
      return;
    }
    if (!clubId) {
      toast.error('Join a club first - chips are held per club');
      return;
    }
    setPurchasing(pkgId);
    try {
      await callClubArenaApi('purchase-chips', { packageId: pkgId, clubId });
      toast.success(`${fmt(chips)} chips added to your club balance`);
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
          Convert diamonds into chips for this club&apos;s games and shop. Chips are held per club;
          diamonds are global.{' '}
          {wallet.loaded ? (
            <>
              You have <strong>{fmt(wallet.diamonds)}</strong> diamonds.
            </>
          ) : (
            <>Your diamond balance is unavailable right now.</>
          )}
        </p>
      </div>

      <div className={styles.pkgGrid}>
        {packages.map((pkg) => {
          const affordable = wallet.loaded && wallet.diamonds >= pkg.diamonds;
          const value = pkg.valuePct ?? pkg.bonus;
          return (
            <div
              key={pkg.id}
              className={`${styles.pkgCard} ${pkg.popular ? styles.pkgCardPopular : ''}`}
            >
              {pkg.popular && <span className={styles.pkgRibbon}>BEST VALUE</span>}
              {value ? <span className={styles.pkgBonus}>+{value}% value</span> : null}
              <div className={styles.pkgAmount}>{fmt(pkg.chips)}</div>
              <div className={styles.pkgLabel}>chips</div>
              <button
                className={styles.pkgBuy}
                disabled={purchasing !== null || !affordable || !clubId}
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
