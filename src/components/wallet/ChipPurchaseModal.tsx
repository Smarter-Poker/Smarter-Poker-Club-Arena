/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP PURCHASE MODAL — Buy Chips with Diamonds
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { callClubArenaApi } from '../../services/clubArenaApi';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './ChipPurchaseModal.css';

interface ChipPurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentDiamonds: number;
  /**
   * Club the chips are for. Chips live on club_members.chip_balance, so
   * WITHOUT this the server credits the global player wallet, which the club
   * shop, buy-ins and cashier cannot spend. See fn_purchase_club_chips.
   */
  clubId?: string | null;
  onPurchase?: (chipAmount: number) => void;
}

interface ChipPackage {
  id: string;
  chips: number;
  diamonds: number;
  bonus?: number;
  popular?: boolean;
}

const CHIP_PACKAGES: ChipPackage[] = [
  { id: 'small', chips: 1000, diamonds: 10 },
  { id: 'medium', chips: 5000, diamonds: 45, bonus: 10 },
  { id: 'large', chips: 10000, diamonds: 80, bonus: 20, popular: true },
  { id: 'mega', chips: 50000, diamonds: 350, bonus: 30 },
  { id: 'ultra', chips: 100000, diamonds: 600, bonus: 50 },
];

export function ChipPurchaseModal({
  isOpen,
  onClose,
  currentDiamonds,
  clubId,
  onPurchase,
}: ChipPurchaseModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const animTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
    if (isOpen) {
      CHIP_PACKAGES.forEach((_, i) => {
        const t = setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60);
        animTimers.current.push(t);
      });
    } else {
      setVisibleItems(new Set());
    }
    return () => {
      animTimers.current.forEach(clearTimeout);
      animTimers.current = [];
    };
  }, [isOpen]);

  const handlePurchase = async (pkg: ChipPackage) => {
    if (!user?.id) return;
    if (currentDiamonds < pkg.diamonds) {
      toast.error('Insufficient diamonds');
      return;
    }
    if (!clubId) {
      toast.error('Open the cashier from a club — chips are held per club');
      return;
    }

    setPurchasing(pkg.id);
    try {
      // Purchase SERVER-SIDE, sending ONLY the package id.
      // The old call passed the chip amount AND the diamond price from this
      // component's hard-coded CHIP_PACKAGES list, so the price was entirely
      // client-controlled. (It never actually ran: fn_purchase_chips is
      // service_role-only and those parameter names do not exist on it.)
      // The route holds the authoritative package table, charges the diamonds
      // and credits the chips atomically, and is idempotent against double-taps.
      await callClubArenaApi('purchase-chips', { packageId: pkg.id, clubId });

      if (!isMounted.current) return;
      toast.success(`${pkg.chips.toLocaleString()} chips added to your wallet!`);
      onPurchase?.(pkg.chips);
      onClose();
    } catch (error) {
      if (isMounted.current) toast.error('Purchase failed');
    }
    if (isMounted.current) setPurchasing(null);
  };

  if (!isOpen) return null;

  return (
    <div className="chip-purchase-overlay" onClick={onClose}>
      <div className="chip-purchase" onClick={(e) => e.stopPropagation()}>
        <div className="chip-purchase__header">
          <h3> Buy Chips</h3>
          <span className="diamond-balance"> {currentDiamonds.toLocaleString()}</span>
          <button className="close-btn" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="chip-purchase__packages">
          {CHIP_PACKAGES.map((pkg, i) => (
            <div
              key={pkg.id}
              className={`package ${pkg.popular ? 'popular' : ''}`}
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              {pkg.popular && <span className="popular-badge">BEST VALUE</span>}
              {pkg.bonus && <span className="bonus-badge">+{pkg.bonus}% Bonus</span>}

              <div className="package__chips">
                <span className="value">{pkg.chips.toLocaleString()}</span>
                <span className="label">Chips</span>
              </div>

              <button
                className="package__buy"
                onClick={() => handlePurchase(pkg)}
                disabled={purchasing !== null || currentDiamonds < pkg.diamonds || !clubId}
              >
                {purchasing === pkg.id ? '...' : `${pkg.diamonds} `}
              </button>
            </div>
          ))}
        </div>

        <div className="chip-purchase__footer">
          <span>Need more diamonds?</span>
          <button className="buy-diamonds">Get Diamonds →</button>
        </div>
      </div>
    </div>
  );
}

export default ChipPurchaseModal;
