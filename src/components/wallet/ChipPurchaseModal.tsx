/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP PURCHASE MODAL — Buy Chips with Diamonds
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './ChipPurchaseModal.css';
import { retryAsync } from '../../utils/retryAsync';

interface ChipPurchaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentDiamonds: number;
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

    setPurchasing(pkg.id);
    try {
      const { error } = await retryAsync(
        () =>
          supabase.rpc('fn_purchase_chips', {
            p_user_id: user.id,
            p_diamond_cost: pkg.diamonds,
            p_chip_amount: pkg.chips,
          }),
        3
      );

      if (error) throw error;

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
                disabled={purchasing !== null || currentDiamonds < pkg.diamonds}
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
