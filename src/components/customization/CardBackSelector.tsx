/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CARD BACK SELECTOR — Diamond-Purchasable Card Back Store
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Every tile here is one of the twelve designs in CARD_BACK_CATALOG
 * (CardImage.tsx), which is keyed by the ids the artwork is named after. That
 * is the whole point of the 2026-08-25 rewrite:
 *
 * WHAT WAS WRONG. The store kept its own list of twelve INVENTED ids — black,
 * red, blue, white, classic, burgundy, navy, gold, holographic, carbon,
 * club-branded, diamond-foil. normalizeCardBack collapsed them onto SEVEN real
 * designs, so:
 *
 *   - `classic` (50 diamonds) and `burgundy` (75 diamonds) painted the exact
 *     same picture as the FREE `red`;
 *   - `navy` (75 diamonds) painted the exact same picture as the free `blue`,
 *     which itself painted the same picture as the free `black`;
 *   - four designs that DO have artwork on disk — diamond, dragon, galaxy,
 *     neon — were not for sale here or anywhere else.
 *
 * A player could spend 200 diamonds across three purchases and end up looking
 * at two pictures, one of which they already had for nothing. Nothing errored,
 * because nothing was wrong from the code's point of view: every id resolved.
 *
 * WHAT IS TRUE NOW. Twelve tiles, twelve distinct designs, one artwork file
 * each. Ownership is the shared isCardBackUnlocked rule, so a VIP and a
 * purchaser both get in, and the theme modal agrees. Selecting equips
 * immediately (the table repaints off the bus) and confirms with a toast; a
 * selection the parent could not persist reports the failure instead of
 * congratulating you.
 *
 * Earlier fixes preserved here: previews resolve through MEDIA_BASE (the SPA
 * is served from /hub/club-arena/, so root-absolute paths 404), and every tile
 * paints a designed placeholder underneath the image so a slow or missing
 * asset degrades instead of showing a broken-image glyph.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  CARD_BACK_CATALOG,
  cardBackImageUrl,
  isCardBackUnlocked,
  normalizeCardBack,
  type CardBackDesign,
} from '../table/CardImage';
import { masterBus } from '../../core/MasterBus';
import { haptic } from '../../services/SoundService';
import { useToast } from '../common/Toast';
import './CardBackSelector.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface CardBackSelectorProps {
  currentCardBack: string;
  ownedCardBacks: string[];
  userDiamonds?: number;
  /** VIP unlocks the paid tiers, exactly as it does in Theme Settings. */
  isVip?: boolean;
  /**
   * Equip handler. May be async: if it rejects, the store says so rather than
   * reporting a success it cannot vouch for.
   */
  onChange?: (cardBackId: string) => void | Promise<unknown>;
  onPurchase?: (cardBackId: string, price: number) => void | Promise<unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLACEHOLDERS
// ═══════════════════════════════════════════════════════════════════════════════

// Per-design placeholder styling, painted under the artwork so a missing or
// still-loading asset shows a designed tile rather than an empty box.
const PLACEHOLDER_STYLES: Record<string, string> = {
  classic_blue: 'linear-gradient(145deg, #1e3a8a 0%, #0b1733 100%)',
  classic_red: 'linear-gradient(145deg, #7f1d1d 0%, #3b0a0a 100%)',
  royal: 'linear-gradient(145deg, #4a0080 0%, #1a0030 100%)',
  neon: 'linear-gradient(145deg, #00f0ff 0%, #0066ff 100%)',
  galaxy: 'linear-gradient(145deg, #2b1055 0%, #7597de 100%)',
  diamond: 'linear-gradient(145deg, #b9f2ff 0%, #4aa3c7 100%)',
  dragon: 'linear-gradient(145deg, #7a1f1f 0%, #2b0808 100%)',
  gold: 'linear-gradient(145deg, #b8860b 0%, #6b4c05 100%)',
  carbon: 'linear-gradient(145deg, #2a2d33 0%, #101216 100%)',
  holographic: 'linear-gradient(145deg, #7c3aed 0%, #06b6d4 50%, #ec4899 100%)',
  'club-branded': 'linear-gradient(145deg, #14532d 0%, #06210f 100%)',
  'diamond-foil': 'linear-gradient(145deg, #cbd5e1 0%, #64748b 50%, #e2e8f0 100%)',
};

function placeholderFor(design: CardBackDesign): string {
  return PLACEHOLDER_STYLES[design.id] || 'linear-gradient(145deg, #23262e 0%, #0d0f14 100%)';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const CardBackSelector: React.FC<CardBackSelectorProps> = ({
  currentCardBack,
  ownedCardBacks,
  userDiamonds = 0,
  isVip = false,
  onChange,
  onPurchase,
}) => {
  const toast = useToast();
  // The equipped design, resolved through the same normaliser the felt uses,
  // so a row still holding a legacy store id ('navy', 'white', 'standard-red')
  // highlights the design it actually paints.
  const equippedId = normalizeCardBack(currentCardBack);
  const [selected, setSelected] = useState(equippedId);
  const [confirmPurchase, setConfirmPurchase] = useState<CardBackDesign | null>(null);
  const [busy, setBusy] = useState(false);
  // Designs whose artwork failed to load — rendered as styled placeholders.
  const [brokenPreviews, setBrokenPreviews] = useState<Record<string, boolean>>({});

  // A card back can also be changed from the table hamburger menu or from
  // Theme Settings while this panel is open. Without this the store kept
  // showing its own stale ring and told the player they had picked something
  // they had since changed.
  useEffect(() => {
    setSelected(equippedId);
  }, [equippedId]);

  const isOwned = useCallback(
    (design: CardBackDesign): boolean =>
      isCardBackUnlocked(design.id, { isVip, owned: ownedCardBacks }),
    [isVip, ownedCardBacks]
  );

  const equip = useCallback(
    async (design: CardBackDesign) => {
      const previous = selected;
      setSelected(design.id);
      setBusy(true);
      try {
        await onChange?.(design.id);
        // The required handler owns the one canonical optimistic event and
        // durable write. Emitting a second unscoped event here let another
        // account's tab consume the same choice and made the felt render twice.
        toast.success(`Equipped The ${design.name} Card Back`);
      } catch {
        setSelected(previous);
        toast.error('Could Not Equip That Card Back. Please Try Again.');
      }
      setBusy(false);
    },
    [onChange, selected, toast]
  );

  const handleSelect = useCallback(
    (design: CardBackDesign) => {
      if (busy) return;
      if (isOwned(design)) {
        haptic.light();
        void equip(design);
      } else if (design.price > 0) {
        haptic.medium();
        setConfirmPurchase(design);
      }
    },
    [busy, equip, isOwned]
  );

  const handleConfirmPurchase = useCallback(async () => {
    if (!confirmPurchase || confirmPurchase.price <= 0) return;
    if (userDiamonds < confirmPurchase.price) return;

    const design = confirmPurchase;
    haptic.strong();
    setConfirmPurchase(null);
    setBusy(true);
    try {
      await onPurchase?.(design.id, design.price);
      masterBus.emit('DIAMOND_SPENT', {
        amount: design.price,
        item: `card_back_${design.id}`,
        category: 'cosmetic',
      });
    } catch {
      setBusy(false);
      toast.error('Could Not Complete That Purchase. Please Try Again.');
      return;
    }
    setBusy(false);
    // Auto-equip after purchase, through the same path (and the same toast)
    // as any other equip.
    await equip(design);
  }, [confirmPurchase, equip, onPurchase, toast, userDiamonds]);

  const handleCancelPurchase = useCallback(() => {
    setConfirmPurchase(null);
  }, []);

  return (
    <div className="card-back-selector">
      <h3 className="cbs-title">Card Back Design</h3>
      <p className="cbs-subtitle">
        Select Your Card Back Style
        <span className="cbs-balance">{userDiamonds.toLocaleString()} Diamonds</span>
      </p>

      <div className="card-backs-grid">
        {CARD_BACK_CATALOG.map((design) => {
          const owned = isOwned(design);
          const isSelected = selected === design.id;
          const isEquipped = equippedId === design.id;

          return (
            <div
              key={design.id}
              className={[
                'card-back-item',
                isSelected ? 'cbs-selected' : '',
                !owned ? 'cbs-locked' : '',
                isEquipped ? 'cbs-equipped' : '',
                design.tier === 'exclusive' ? 'cbs-exclusive' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSelect(design)}
              data-tier={design.tier}
              data-card-back={design.id}
            >
              <div className="card-back-preview">
                <div
                  className="card-shape"
                  /* Placeholder always paints underneath, so a slow or missing
                     asset shows a designed tile rather than an empty box. */
                  style={{ background: placeholderFor(design) }}
                >
                  {!brokenPreviews[design.id] && (
                    <img
                      loading="lazy"
                      decoding="async"
                      src={cardBackImageUrl(design.id)}
                      alt={`${design.name} card back`}
                      className="card-back-preview-img"
                      draggable={false}
                      onError={() =>
                        setBrokenPreviews((prev) =>
                          prev[design.id] ? prev : { ...prev, [design.id]: true }
                        )
                      }
                    />
                  )}
                </div>
              </div>

              <span className="card-back-name">{design.name}</span>

              {/* Status badges */}
              {isEquipped && <span className="cbs-badge cbs-badge--equipped">Equipped</span>}
              {owned && !isEquipped && <span className="cbs-badge cbs-badge--owned">Owned</span>}
              {!owned && design.price > 0 && (
                <span
                  className="cbs-badge cbs-badge--price"
                  title={`${design.price.toLocaleString()} Diamonds`}
                >
                  {design.price.toLocaleString()}
                </span>
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
                  src={cardBackImageUrl(confirmPurchase.id)}
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
            <p className="cbs-confirm__cost">{confirmPurchase.price.toLocaleString()} Diamonds</p>

            {userDiamonds < confirmPurchase.price && (
              <p className="cbs-confirm__insufficient">
                Insufficient Diamonds ({userDiamonds.toLocaleString()} /{' '}
                {confirmPurchase.price.toLocaleString()})
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
                className={`cbs-confirm__btn cbs-confirm__btn--buy ${userDiamonds < confirmPurchase.price ? 'cbs-confirm__btn--disabled' : ''}`}
                onClick={handleConfirmPurchase}
                disabled={userDiamonds < confirmPurchase.price}
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
