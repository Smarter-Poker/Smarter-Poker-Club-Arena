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
 *
 * Dan 2026-08-20: every thumbnail rendered broken in production. Two causes,
 * both fixed here:
 *   1. previews were root-absolute ('/cards/backs/x.webp'). The SPA is served
 *      from /hub/club-arena/, so every one of them 404'd. They now resolve
 *      through MEDIA_BASE like the rest of the app's media.
 *   2. four designs (holographic, carbon, club-branded, diamond-foil) have no
 *      artwork in the repo at all, so a correct path still cannot paint. Every
 *      tile now falls back to a styled, per-design placeholder instead of the
 *      browser's broken-image glyph — a missing asset degrades, never breaks.
 *
 * PERF PASS 2026-08-22 (handoff item 4): previews now show the TABLE art.
 * A purchase resolves through normalizeCardBack to a design in
 * cards/backs/table/, but the thumbnails pointed at unrelated full-size
 * originals — so what you previewed was not what your cards looked like
 * after buying (burgundy's preview was distinct art, the table renders
 * classic_red). Deriving the preview path from normalizeCardBack keeps the
 * store honest by construction and follows any future alias change
 * automatically. Side benefit: table webps are ~38KB, and cause 2 above is
 * moot — every normalized target has artwork in cards/backs/table/.
 */

import React, { useState, useCallback } from 'react';
import { MEDIA_BASE } from '../../utils/mediaBase';
import { normalizeCardBack } from '../table/CardImage';
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

// Preview = the art the table will actually render for this id.
const tableArt = (id: string) => `${MEDIA_BASE}cards/backs/table/${normalizeCardBack(id)}.webp`;

const CARD_BACKS: CardBack[] = [
  // ── Free defaults ──
  {
    id: 'black',
    name: 'Black',
    preview: tableArt('black'),
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'red',
    name: 'Red',
    preview: tableArt('red'),
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'blue',
    name: 'Blue',
    preview: tableArt('blue'),
    isDefault: true,
    tier: 'standard',
  },
  {
    id: 'white',
    name: 'White',
    preview: tableArt('white'),
    isDefault: true,
    tier: 'standard',
  },

  // ── Premium (diamond purchase) ──
  {
    id: 'classic',
    name: 'Classic',
    preview: tableArt('classic'),
    isPremium: true,
    price: 50,
    tier: 'premium',
  },
  {
    id: 'burgundy',
    name: 'Burgundy',
    preview: tableArt('burgundy'),
    isPremium: true,
    price: 75,
    tier: 'premium',
  },
  {
    id: 'navy',
    name: 'Navy',
    preview: tableArt('navy'),
    isPremium: true,
    price: 75,
    tier: 'premium',
  },
  {
    id: 'gold',
    name: 'Premium Gold',
    preview: tableArt('gold'),
    isPremium: true,
    price: 150,
    tier: 'premium',
  },

  // ── Exclusive (diamond purchase, higher tier) ──
  {
    id: 'holographic',
    name: 'Holographic',
    preview: tableArt('holographic'),
    isPremium: true,
    price: 200,
    tier: 'exclusive',
  },
  {
    id: 'carbon',
    name: 'Carbon Fiber',
    preview: tableArt('carbon'),
    isPremium: true,
    price: 175,
    tier: 'exclusive',
  },
  {
    id: 'club-branded',
    name: 'Club Crest',
    preview: tableArt('club-branded'),
    isPremium: true,
    price: 250,
    tier: 'exclusive',
  },
  {
    id: 'diamond-foil',
    name: 'Diamond Foil',
    preview: tableArt('diamond-foil'),
    isPremium: true,
    price: 300,
    tier: 'exclusive',
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

// Per-design placeholder styling, used when a design has no artwork (or the
// artwork fails to load). Keeps the grid readable instead of showing the
// browser's broken-image glyph.
const PLACEHOLDER_STYLES: Record<string, string> = {
  black: 'linear-gradient(145deg, #23262e 0%, #0d0f14 100%)',
  red: 'linear-gradient(145deg, #7f1d1d 0%, #3b0a0a 100%)',
  blue: 'linear-gradient(145deg, #1e3a8a 0%, #0b1733 100%)',
  white: 'linear-gradient(145deg, #e8eaf0 0%, #a9b0c0 100%)',
  classic: 'linear-gradient(145deg, #3f4756 0%, #1b1f28 100%)',
  burgundy: 'linear-gradient(145deg, #6b1230 0%, #2b0714 100%)',
  navy: 'linear-gradient(145deg, #16305c 0%, #08122a 100%)',
  gold: 'linear-gradient(145deg, #b8860b 0%, #6b4c05 100%)',
  holographic: 'linear-gradient(145deg, #7c3aed 0%, #06b6d4 50%, #ec4899 100%)',
  carbon: 'linear-gradient(145deg, #2a2d33 0%, #101216 100%)',
  'club-branded': 'linear-gradient(145deg, #14532d 0%, #06210f 100%)',
  'diamond-foil': 'linear-gradient(145deg, #cbd5e1 0%, #64748b 50%, #e2e8f0 100%)',
};

function placeholderFor(cardBack: CardBack): string {
  return PLACEHOLDER_STYLES[cardBack.id] || 'linear-gradient(145deg, #23262e 0%, #0d0f14 100%)';
}

export const CardBackSelector: React.FC<CardBackSelectorProps> = ({
  currentCardBack,
  ownedCardBacks,
  userDiamonds = 0,
  onChange,
  onPurchase,
}) => {
  const [selected, setSelected] = useState(currentCardBack);
  const [confirmPurchase, setConfirmPurchase] = useState<CardBack | null>(null);
  // Designs whose artwork failed to load — rendered as styled placeholders.
  const [brokenPreviews, setBrokenPreviews] = useState<Record<string, boolean>>({});

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
      <p className="cbs-subtitle">Select Your Card Back Style • {userDiamonds}</p>

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
                <div
                  className="card-shape"
                  /* Placeholder always paints underneath, so a slow or missing
                     asset shows a designed tile rather than an empty box. */
                  style={{ background: placeholderFor(cardBack) }}
                >
                  {!brokenPreviews[cardBack.id] && (
                    <img
                      loading="lazy"
                      decoding="async"
                      src={cardBack.preview}
                      alt={`${cardBack.name} card back`}
                      className="card-back-preview-img"
                      draggable={false}
                      onError={() =>
                        setBrokenPreviews((prev) =>
                          prev[cardBack.id] ? prev : { ...prev, [cardBack.id]: true }
                        )
                      }
                    />
                  )}
                </div>
              </div>

              <span className="card-back-name">{cardBack.name}</span>

              {/* Status badges */}
              {isEquipped && <span className="cbs-badge cbs-badge--equipped">Equipped</span>}
              {owned && !isEquipped && <span className="cbs-badge cbs-badge--owned">Owned</span>}
              {!owned && cardBack.price && (
                <span className="cbs-badge cbs-badge--price"> {cardBack.price}</span>
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

            <div
              className="cbs-confirm__preview"
              style={{ background: placeholderFor(confirmPurchase) }}
            >
              {!brokenPreviews[confirmPurchase.id] && (
                <img
                  loading="lazy"
                  decoding="async"
                  src={confirmPurchase.preview}
                  alt={confirmPurchase.name}
                  className="cbs-confirm__img"
                  onError={() =>
                    setBrokenPreviews((prev) =>
                      prev[confirmPurchase.id] ? prev : { ...prev, [confirmPurchase.id]: true }
                    )
                  }
                />
              )}
            </div>

            <p className="cbs-confirm__name">{confirmPurchase.name}</p>
            <p className="cbs-confirm__cost"> {confirmPurchase.price} Diamonds</p>

            {userDiamonds < (confirmPurchase.price || 0) && (
              <p className="cbs-confirm__insufficient">
                Insufficient Diamonds ({userDiamonds} / {confirmPurchase.price})
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
