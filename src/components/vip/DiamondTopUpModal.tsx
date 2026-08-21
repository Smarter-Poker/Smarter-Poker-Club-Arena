/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND TOP-UP MODAL — Purchase Diamond Packages
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState } from 'react';
import { DiamondService, DIAMOND_PACKAGES, DiamondPackage } from '../../services/DiamondService';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import './DiamondTopUpModal.css';

interface DiamondTopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  onPurchaseComplete?: (newBalance: number) => void;
}

export function DiamondTopUpModal({ isOpen, onClose, onPurchaseComplete }: DiamondTopUpModalProps) {
  const { user } = useAuthUser();
  const toast = useToast();
  const [purchasing, setPurchasing] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePurchase = async (pkg: DiamondPackage) => {
    if (!user?.id || purchasing) return;
    setPurchasing(pkg.id);

    const result = await DiamondService.purchaseDiamonds(user.id, pkg.id);

    if (result.success) {
      toast.success(`${pkg.diamonds + pkg.bonusDiamonds} diamonds added!`);
      onPurchaseComplete?.(result.newBalance || 0);
      onClose();
    } else {
      toast.error(result.error || 'Purchase failed');
    }

    setPurchasing(null);
  };

  const formatPrice = (price: number) => `${price.toLocaleString()} diamonds`;

  return (
    <div className="diamond-modal-overlay" onClick={onClose}>
      <div className="diamond-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diamond-modal__header">
          <h2>Diamond Store</h2>
          <button className="diamond-modal__close" onClick={onClose}>
            ×
          </button>
        </div>

        <p className="diamond-modal__desc">
          Diamonds Power Your VIP Features, Themes, And Throwables.
        </p>

        <div className="diamond-modal__grid">
          {DIAMOND_PACKAGES.map((pkg) => (
            <div
              key={pkg.id}
              className={`diamond-package ${pkg.popular ? 'diamond-package--popular' : ''} ${pkg.bestValue ? 'diamond-package--best' : ''}`}
            >
              {pkg.popular && <span className="diamond-package__badge">Most Popular</span>}
              {pkg.bestValue && (
                <span className="diamond-package__badge diamond-package__badge--best">
                  Best Value
                </span>
              )}

              <div className="diamond-package__amount">
                <span className="diamond-package__diamonds">{pkg.diamonds.toLocaleString()}</span>
                {pkg.bonusDiamonds > 0 && (
                  <span className="diamond-package__bonus">
                    +{pkg.bonusDiamonds.toLocaleString()} Bonus
                  </span>
                )}
              </div>

              <span className="diamond-package__name">{pkg.name}</span>

              <button
                className="diamond-package__btn"
                onClick={() => handlePurchase(pkg)}
                disabled={purchasing !== null}
              >
                {purchasing === pkg.id ? '...' : formatPrice(pkg.priceUSD)}
              </button>
            </div>
          ))}
        </div>

        <p className="diamond-modal__note">Purchases Are Instant. Diamonds Never Expire.</p>
      </div>
    </div>
  );
}

export default DiamondTopUpModal;
