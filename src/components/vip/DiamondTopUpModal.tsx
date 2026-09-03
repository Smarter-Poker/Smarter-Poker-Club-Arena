/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND TOP-UP MODAL — Purchase Diamond Packages
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * REWRITTEN 2026-08-25 by the cosmetics purchase/ownership audit. What was here
 * before quoted prices that did not exist, in the wrong currency, for a button
 * that could not charge anybody:
 *
 *   - `formatPrice(pkg.priceUSD)` rendered `${price} diamonds`, so the Starter
 *     button read "0.99 diamonds" for a $0.99 charge and the top pack read
 *     "49.99 diamonds" for $49.99. Every one of the six buttons named the
 *     wrong currency.
 *
 *   - The packages came from DiamondService.DIAMOND_PACKAGES — a SECOND price
 *     list (starter/popular/value/premium/elite/whale, $0.99-$49.99) that
 *     disagrees with the one the checkout route actually bills. No route sells
 *     a "Diamond Vault". This is the same shape as the CurrencyStore deleted
 *     earlier: a storefront quoting packs that do not exist.
 *
 *   - It called DiamondService.purchaseDiamonds WITHOUT a paymentMethodId, so
 *     the Stripe branch was skipped and it fell through to the dev-only
 *     `fn_add_diamonds` RPC — a free credit of up to 20,000 diamonds. That RPC
 *     is not executable by `authenticated` (verified against production), so
 *     the button could only ever show the buyer a raw Postgres permission
 *     error. "Purchases Are Instant" was printed underneath it.
 *
 * Now: the same server catalog and the same Stripe Checkout session the
 * marketplace Diamonds tab uses. The client sends a package id and nothing
 * else — never an amount, never a price.
 */

import React, { useEffect, useRef, useState } from 'react';
import { useToast } from '../common/Toast';
import {
  loadStoreCatalog,
  startCheckout,
  type DiamondPackage,
} from '../../pages/marketplace/marketplaceShared';
import './DiamondTopUpModal.css';

interface DiamondTopUpModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Identifies the surface that should regain control after Stripe returns.
   * The default keeps every existing VIP/wallet caller unchanged; Table Studio
   * supplies its own marker so it can restore the exact locked design.
   */
  returnParams?: string;
  /**
   * Kept so callers compile unchanged, but NOT invoked: the balance now moves
   * at Stripe, after a redirect, so there is no in-modal moment at which a new
   * balance is known. Announcing one here is how the old modal reported a
   * successful purchase that never happened.
   */
  onPurchaseComplete?: (newBalance: number) => void;
}

export function DiamondTopUpModal({
  isOpen,
  onClose,
  returnParams = 'from=vip',
}: DiamondTopUpModalProps) {
  const toast = useToast();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [packages, setPackages] = useState<DiamondPackage[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    setLoadError(false);
    // Never rejects: it reports and falls back to the bundled table, which
    // mirrors the checkout route's own list.
    loadStoreCatalog()
      .then((catalog) => {
        if (!alive) return;
        setPackages(catalog.diamondPackages);
        setLoadError(!catalog.fromServer);
      })
      .catch(() => alive && setLoadError(true));
    return () => {
      alive = false;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex="0"]'
        ) || []
      );
    window.requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePurchase = async (pkg: DiamondPackage) => {
    if (redirecting) return;
    setRedirecting(pkg.id);
    try {
      // The server re-decides the price from the id. On success this never
      // returns — it navigates to Stripe.
      await startCheckout('diamonds', [{ packageId: pkg.id, quantity: 1 }], returnParams);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could Not Start Checkout');
      setRedirecting(null);
    }
  };

  return (
    <div className="diamond-modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="diamond-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diamond-store-title"
        aria-describedby="diamond-store-description"
        aria-busy={redirecting !== null}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="diamond-modal__header">
          <div>
            <span className="diamond-modal__eyebrow">SECURE PLAYER CHECKOUT</span>
            <h2 id="diamond-store-title">Add Diamonds</h2>
          </div>
          <button
            className="diamond-modal__close"
            onClick={onClose}
            aria-label="Close Diamond Store"
          >
            ×
          </button>
        </div>

        <p id="diamond-store-description" className="diamond-modal__desc">
          Choose A Pack. Stripe Confirms The Price Before Payment, Then Your Balance Updates From
          The Server.
        </p>

        {/* A catalog that could not be read is not an empty store. */}
        {packages === null ? (
          <div className="diamond-modal__loading" role="status">
            <span />
            Loading Secure Packages
          </div>
        ) : (
          <>
            {loadError && (
              <p className="diamond-modal__desc" role="alert">
                Showing Our Standard Packages. Checkout Will Confirm The Exact Price.
              </p>
            )}
            <div className="diamond-modal__grid">
              {packages.map((pkg) => (
                <div
                  key={pkg.id}
                  className={`diamond-package ${pkg.popular ? 'diamond-package--popular' : ''}`}
                >
                  {pkg.popular && <span className="diamond-package__badge">Most Popular</span>}

                  <div className="diamond-package__amount">
                    <span className="diamond-package__diamonds">
                      {pkg.diamonds.toLocaleString()}
                    </span>
                    {pkg.bonus > 0 && (
                      <span className="diamond-package__bonus">
                        +{pkg.bonus.toLocaleString()} Bonus
                      </span>
                    )}
                  </div>

                  <span className="diamond-package__name">{pkg.name}</span>

                  <button
                    className="diamond-package__btn"
                    onClick={() => handlePurchase(pkg)}
                    disabled={redirecting !== null}
                    aria-label={`Buy ${pkg.name}, ${(pkg.diamonds + pkg.bonus).toLocaleString()} Diamonds For $${pkg.priceUsd.toFixed(2)}`}
                  >
                    {/* DOLLARS, LABELLED AS DOLLARS. */}
                    {redirecting === pkg.id ? '...' : `$${pkg.priceUsd.toFixed(2)}`}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="diamond-modal__trust" aria-label="Checkout Assurances">
          <span>Stripe Checkout</span>
          <span>Server-Priced</span>
          <span>Permanent Balance</span>
        </div>
      </div>
    </div>
  );
}

export default DiamondTopUpModal;
