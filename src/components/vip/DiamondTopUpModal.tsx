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

import React, { useEffect, useState } from 'react';
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
   * Kept so callers compile unchanged, but NOT invoked: the balance now moves
   * at Stripe, after a redirect, so there is no in-modal moment at which a new
   * balance is known. Announcing one here is how the old modal reported a
   * successful purchase that never happened.
   */
  onPurchaseComplete?: (newBalance: number) => void;
}

export function DiamondTopUpModal({ isOpen, onClose }: DiamondTopUpModalProps) {
  const toast = useToast();
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

  if (!isOpen) return null;

  const handlePurchase = async (pkg: DiamondPackage) => {
    if (redirecting) return;
    setRedirecting(pkg.id);
    try {
      // The server re-decides the price from the id. On success this never
      // returns — it navigates to Stripe.
      await startCheckout('diamonds', [{ packageId: pkg.id, quantity: 1 }], 'from=vip');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could Not Start Checkout');
      setRedirecting(null);
    }
  };

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

        {/* A catalog that could not be read is not an empty store. */}
        {packages === null ? (
          <p className="diamond-modal__desc">Loading Packages...</p>
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
                  >
                    {/* DOLLARS, LABELLED AS DOLLARS. */}
                    {redirecting === pkg.id ? '...' : `$${pkg.priceUsd.toFixed(2)}`}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="diamond-modal__note">
          Secure Payment Via Stripe. Diamonds Are Credited After Payment And Never Expire.
        </p>
      </div>
    </div>
  );
}

export default DiamondTopUpModal;
