/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD BACK SELECTOR — Diamond-Purchasable Card Back Store
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Grid of available card back designs with purchase flow:
 *   - 4 default backs (free)
 *   - 8 premium backs (diamond-gated, with confirm modal)
 *   - Equipped badge, owned badge, locked + price overlay
 *   - Bus emission on purchase and equip
 */

import React, { useState, useCallback } from 'react';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import './CardBackSelector.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface CardBack {
  id: string;
  name: string;
  preview: string;
  isDefault?: boolean;
  isPremium?: boolean;
  price?: number;
  tier?: 'standard' | 'premium' | 'exclusive';
}

interface CardBackSelectorProps {
  currentCardBack: string;
  ownedCardBacks: string[];
  userDiamonds?: number;
  onChange?: (cardBackId: string) => void;
  onPurchase?: (cardBackId: string, price: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CARD BACK CATALOG
// ═══════════════════════════════════════════════════════════════════════════════

const CARD_BACKS: CardBack[] = [
  // ── Free defaults ──
  {
    id: 'black',
    name: 'Black',
    preview: '/cards/backs/black.webp',
    isDefault: true,
    tier: 'standard',
  },
  { id: 'red', name: 'Red', preview: '/cards/backs/red.webp', isDefault: true, tier: 'standard' },
  {
    id: 'blue',
    name: 'Blue',
    preview: '/cards/backs/blue.webp',
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'white',
    name: 'White',
    preview: '/cards/backs/white.webp',
    isDefault: true,
    tier: 'standard',
  },

  // ── Premium (diamond purchase) ──
  {
    id: 'classic',
    name: 'Classic',
    preview: '/cards/backs/classic.webp',
    isPremium: true,
    price: 50,
    tier: 'premium',
  },
  {
    id: 'burgundy',
    name: 'Burgundy',
    preview: '/cards/backs/burgundy.webp',
    isPremium: true,
    price: 75,
    tier: 'premium',
  },
  {
    id: 'navy',
    name: 'Navy',
    preview: '/cards/backs/navy.webp',
    isPremium: true,
    price: 75,
    tier: 'premium',
  },
  {
    id: 'gold',
    name: 'Premium Gold',
    preview: '/cards/backs/gold.webp',
    isPremium: true,
    price: 150,
    tier: 'premium',
  },

  // ── Exclusive (diamond purchase, higher tier) ──
  {
    id: 'holographic',
    name: 'Holographic',
    preview: '/cards/backs/holographic.webp',
    isPremium: true,
    price: 200,
    tier: 'exclusive',
  },
  {
    id: 'carbon',
    name: 'Carbon Fiber',
    preview: '/cards/backs/carbon.webp',
    isPremium: true,
    price: 175,
    tier: 'exclusive',
  },
  {
    id: 'club-branded',
    name: 'Club Crest',
    preview: '/cards/backs/club-branded.jpg',
    isPremium: true,
    price: 250,
    tier: 'exclusive',
  },
  {
    id: 'diamond-foil',
    name: 'Diamond Foil',
    preview: '/cards/backs/diamond-foil.jpg',
    isPremium: true,
    price: 300,
    tier: 'exclusive',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const CardBackSelector: React.FC<CardBackSelectorProps> = ({
  currentCardBack,
  ownedCardBacks,
  userDiamonds = 0,
  onChange,
  onPurchase,
}) => {
  const [selected, setSelected] = useState(currentCardBack);
  const [confirmPurchase, setConfirmPurchase] = useState<CardBack | null>(null);

  const isOwned = useCallback(
    (cardBack: CardBack): boolean => {
      return !!cardBack.isDefault || ownedCardBacks.includes(cardBack.id);
    },
    [ownedCardBacks]
  );

  const handleSelect = useCallback(
    (cardBack: CardBack) => {
      if (isOwned(cardBack)) {
        haptic.light();
        setSelected(cardBack.id);
        onChange?.(cardBack.id);
        masterBus.emit('SETTINGS_CHANGED', { setting: 'cardBack', value: cardBack.id });
      } else if (cardBack.price) {
        haptic.medium();
        setConfirmPurchase(cardBack);
      }
    },
    [isOwned, onChange]
  );

  const handleConfirmPurchase = useCallback(() => {
    if (!confirmPurchase || !confirmPurchase.price) return;
    if (userDiamonds < confirmPurchase.price) return;

    haptic.strong();
    onPurchase?.(confirmPurchase.id, confirmPurchase.price);

    // Auto-equip after purchase
    setSelected(confirmPurchase.id);
    onChange?.(confirmPurchase.id);

    masterBus.emit('DIAMOND_SPENT', {
      amount: confirmPurchase.price,
      item: `card_back_${confirmPurchase.id}`,
      category: 'cosmetic',
    });

    setConfirmPurchase(null);
  }, [confirmPurchase, userDiamonds, onPurchase, onChange]);

  const handleCancelPurchase = useCallback(() => {
    setConfirmPurchase(null);
  }, []);

  return (
    <div className="card-back-selector">
      <h3 className="cbs-title">Card Back Design</h3>
      <p className="cbs-subtitle">Select your card back style • 💎 {userDiamonds}</p>

      <div className="card-backs-grid">
        {CARD_BACKS.map((cardBack) => {
          const owned = isOwned(cardBack);
          const isSelected = selected === cardBack.id;
          const isEquipped = currentCardBack === cardBack.id;

          return (
            <div
              key={cardBack.id}
              className={[
                'card-back-item',
                isSelected ? 'cbs-selected' : '',
                !owned ? 'cbs-locked' : '',
                isEquipped ? 'cbs-equipped' : '',
                cardBack.tier === 'exclusive' ? 'cbs-exclusive' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSelect(cardBack)}
              data-tier={cardBack.tier}
            >
              <div className="card-back-preview">
                <div className="card-shape">
                  <img
                    loading="lazy"
                    decoding="async"
                    src={cardBack.preview}
                    alt={`${cardBack.name} card back`}
                    className="card-back-preview-img"
                    draggable={false}
                  />
                </div>
              </div>

              <span className="card-back-name">{cardBack.name}</span>

              {/* Status badges */}
              {isEquipped && <span className="cbs-badge cbs-badge--equipped">Equipped</span>}
              {owned && !isEquipped && <span className="cbs-badge cbs-badge--owned">Owned</span>}
              {!owned && cardBack.price && (
                <span className="cbs-badge cbs-badge--price">💎 {cardBack.price}</span>
              )}

              {isSelected && <div className="selected-indicator" />}
            </div>
          );
        })}
      </div>

      {/* Purchase Confirmation Modal */}
      {confirmPurchase && (
        <div className="cbs-confirm-overlay" onClick={handleCancelPurchase}>
          <div className="cbs-confirm" onClick={(e) => e.stopPropagation()}>
            <h4 className="cbs-confirm__title">Purchase Card Back</h4>

            <div className="cbs-confirm__preview">
              <img
                loading="lazy"
                decoding="async"
                src={confirmPurchase.preview}
                alt={confirmPurchase.name}
                className="cbs-confirm__img"
              />
            </div>

            <p className="cbs-confirm__name">{confirmPurchase.name}</p>
            <p className="cbs-confirm__cost">💎 {confirmPurchase.price} Diamonds</p>

            {userDiamonds < (confirmPurchase.price || 0) && (
              <p className="cbs-confirm__insufficient">
                Insufficient diamonds ({userDiamonds} / {confirmPurchase.price})
              </p>
            )}

            <div className="cbs-confirm__actions">
              <button
                className="cbs-confirm__btn cbs-confirm__btn--cancel"
                onClick={handleCancelPurchase}
              >
                Cancel
              </button>
              <button
                className={`cbs-confirm__btn cbs-confirm__btn--buy ${userDiamonds < (confirmPurchase.price || 0) ? 'cbs-confirm__btn--disabled' : ''}`}
                onClick={handleConfirmPurchase}
                disabled={userDiamonds < (confirmPurchase.price || 0)}
              >
                Buy Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CardBackSelector;
