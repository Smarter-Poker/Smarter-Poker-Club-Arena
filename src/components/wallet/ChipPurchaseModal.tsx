/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CHIP PURCHASE MODAL — Buy Chips with Diamonds
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
   * Club whose chip balance should be credited.
   *
   * Chips are held PER CLUB (club_members.chip_balance) and are not
   * interchangeable. The purchase-chips route branches on this: with a clubId
   * it calls fn_purchase_club_chips (credits that club), without it the legacy
   * fn_purchase_chips credits the GLOBAL player wallet — which the shop,
   * buy-ins and the cashier never read. The route was made club-scoped on
   * 2026-08-19 but this component never sent the id, so every purchase still
   * charged diamonds and credited a balance nothing spends.
   */
  clubId?: string | null;
  /** Called with the chips credited and the server's post-purchase diamond balance. */
  onPurchase?: (chipAmount: number, diamondBalanceAfter?: number) => void;
}

interface PurchaseChipsResponse {
  chipsCredited?: number;
  diamondsCharged?: number;
  diamondBalanceAfter?: number;
  destination?: string;
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
  const navigate = useNavigate();
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
      // Purchase SERVER-SIDE, sending ONLY the package id.
      // The old call passed the chip amount AND the diamond price from this
      // component's hard-coded CHIP_PACKAGES list, so the price was entirely
      // client-controlled. (It never actually ran: fn_purchase_chips is
      // service_role-only and those parameter names do not exist on it.)
      // The route holds the authoritative package table, charges the diamonds
      // and credits the chips atomically, and is idempotent against double-taps.
      // clubId is required for the chips to land in the club the user is
      // actually playing in — see the prop docs above.
      const result = (await callClubArenaApi('purchase-chips', {
        packageId: pkg.id,
        ...(clubId ? { clubId } : {}),
      })) as PurchaseChipsResponse;

      if (!isMounted.current) return;
      const credited = result?.chipsCredited ?? pkg.chips;
      toast.success(`${credited.toLocaleString()} chips added to this club`);
      onPurchase?.(credited, result?.diamondBalanceAfter);
      onClose();
    } catch (error) {
      // The API layer throws with the server's own message (insufficient
      // diamonds, not a member, rate limited, settlement locked). Replacing
      // all of it with "Purchase failed" told the user nothing actionable.
      if (isMounted.current) {
        toast.error(error instanceof Error ? error.message : 'Purchase failed');
      }
    }
    if (isMounted.current) setPurchasing(null);
  };

  if (!isOpen) return null;

  // Never dismiss while a purchase is in flight — diamonds may already be spent
  const closeIfIdle = () => {
    if (!purchasing) onClose();
  };

  return (
    <div
      className="chip-purchase-overlay"
      onClick={closeIfIdle}
      role="dialog"
      aria-modal="true"
      aria-labelledby="chip-purchase-title"
    >
      <div
        className="chip-purchase"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') closeIfIdle();
        }}
      >
        <div className="chip-purchase__header">
          <h3 id="chip-purchase-title">Buy Chips</h3>
          <span className="diamond-balance">{currentDiamonds.toLocaleString()} diamonds</span>
          <button
            type="button"
            className="close-btn"
            onClick={closeIfIdle}
            disabled={!!purchasing}
            aria-label="Close"
          >
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
                type="button"
                className="package__buy"
                onClick={() => handlePurchase(pkg)}
                disabled={purchasing !== null || currentDiamonds < pkg.diamonds}
                aria-label={`Buy ${pkg.chips.toLocaleString()} chips for ${pkg.diamonds} diamonds`}
              >
                {/* The price used to render as a bare number with a trailing
                    space (residue of a stripped emoji), so nothing on screen
                    said what the user was being charged in. */}
                {purchasing === pkg.id ? '...' : `${pkg.diamonds} diamonds`}
              </button>
            </div>
          ))}
        </div>

        <div className="chip-purchase__footer">
          <span>Need more diamonds?</span>
          {/* This button had no onClick at all — a visible, styled, inert
              control in the top-up path. Routed to the VIP/diamond page. */}
          <button
            type="button"
            className="buy-diamonds"
            disabled={!!purchasing}
            onClick={() => {
              onClose();
              navigate('/vip');
            }}
          >
            Get Diamonds →
          </button>
        </div>
      </div>
    </div>
  );
}

export default ChipPurchaseModal;
