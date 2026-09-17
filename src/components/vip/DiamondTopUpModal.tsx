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

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useToast } from '../common/Toast';
import { useAuthUser } from '../../hooks/useAuthUser';
import { formatPopupText } from '../../utils/popupStyle';
import {
  diamondCheckoutOfferConfirmation,
  isVerifiedCheckoutPrecommitRefusal,
  isVerifiedCheckoutTerminalExpiration,
  loadStoreCatalog,
  checkoutProviderReadyForCurrentPlatform,
  marketplacePurchaseScope,
  readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent,
  startCheckout,
  NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE,
  type DiamondPackage,
  type StoreCatalog,
} from '../../pages/marketplace/marketplaceShared';
import './DiamondTopUpModal.css';

const DIAMOND_PACKAGE_ATLAS = `${import.meta.env.BASE_URL}images/marketplace/diamond-packages/diamond-package-atlas-v1.webp`;

type VerifiedDiamondPackage = DiamondPackage & {
  priceCents: number;
  cardCheckoutReady: true;
  diamondCheckoutReady: false;
};

const exactUsdCents = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 1e-8 ? cents : null;
};

/**
 * The shared loader already validates the server response. This local guard is
 * the final component boundary: a malformed mock, stale bundle, or partial
 * response still cannot paint an enabled payment control.
 */
const isDisplayPackage = (value: unknown): value is DiamondPackage => {
  if (!value || typeof value !== 'object') return false;
  const pkg = value as DiamondPackage;
  return (
    typeof pkg.id === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(pkg.id) &&
    typeof pkg.name === 'string' &&
    pkg.name.trim().length > 0 &&
    pkg.name.length <= 200 &&
    Number.isSafeInteger(pkg.diamonds) &&
    pkg.diamonds > 0 &&
    Number.isSafeInteger(pkg.bonus) &&
    pkg.bonus >= 0 &&
    Number.isSafeInteger(pkg.diamonds + pkg.bonus) &&
    exactUsdCents(pkg.priceUsd) !== null &&
    (pkg.popular === undefined || typeof pkg.popular === 'boolean')
  );
};

const displayPackagesFrom = (catalog: unknown): DiamondPackage[] | null => {
  if (!catalog || typeof catalog !== 'object') return null;
  const packages = (catalog as Partial<StoreCatalog>).diamondPackages;
  if (
    !Array.isArray(packages) ||
    packages.length === 0 ||
    !packages.every(isDisplayPackage) ||
    new Set(packages.map((pkg) => pkg.id)).size !== packages.length
  ) {
    return null;
  }
  return packages;
};

const verifiedPackagesFrom = (catalog: unknown): VerifiedDiamondPackage[] | null => {
  if (!catalog || typeof catalog !== 'object') return null;
  const candidate = catalog as Partial<StoreCatalog>;
  const packages = displayPackagesFrom(candidate);
  if (
    candidate.fromServer !== true ||
    !packages ||
    !packages.every(
      (pkg): pkg is VerifiedDiamondPackage =>
        Number.isSafeInteger(pkg.priceCents) &&
        pkg.priceCents === exactUsdCents(pkg.priceUsd) &&
        pkg.cardCheckoutReady === true &&
        pkg.diamondCheckoutReady === false
    )
  ) {
    return null;
  }
  return packages;
};

const exactPackageTerms = (left: VerifiedDiamondPackage, right: VerifiedDiamondPackage) =>
  left.id === right.id &&
  left.name === right.name &&
  left.diamonds === right.diamonds &&
  left.bonus === right.bonus &&
  left.priceUsd === right.priceUsd &&
  left.priceCents === right.priceCents &&
  left.cardCheckoutReady === right.cardCheckoutReady &&
  left.diamondCheckoutReady === right.diamondCheckoutReady;

const purchaseTermsKey = (pkg: VerifiedDiamondPackage) =>
  JSON.stringify({
    version: 1,
    type: 'diamonds',
    packageId: pkg.id,
    quantity: 1,
    diamonds: pkg.diamonds,
    bonus: pkg.bonus,
    priceUsd: pkg.priceUsd,
    priceCents: pkg.priceCents,
  });

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
  const { user } = useAuthUser();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const checkoutInFlightRef = useRef(false);
  const activeOwnerRef = useRef({
    isOpen,
    userId: user?.id ?? null,
    returnParams,
  });
  const checkoutAttemptRef = useRef(0);
  const checkoutAbortRef = useRef<AbortController | null>(null);
  const catalogAbortRef = useRef<AbortController | null>(null);
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const [packages, setPackages] = useState<DiamondPackage[] | null>(null);
  const [catalogVerified, setCatalogVerified] = useState(false);
  const cardPaymentAvailable = checkoutProviderReadyForCurrentPlatform('diamonds');

  useLayoutEffect(() => {
    activeOwnerRef.current = {
      isOpen,
      userId: user?.id ?? null,
      returnParams,
    };
    checkoutAttemptRef.current += 1;
    checkoutAbortRef.current?.abort();
    checkoutAbortRef.current = null;
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = null;
    checkoutInFlightRef.current = false;
    setRedirecting(null);
  }, [isOpen, returnParams, user?.id]);

  useEffect(
    () => () => {
      checkoutAttemptRef.current += 1;
      checkoutAbortRef.current?.abort();
      checkoutAbortRef.current = null;
      catalogAbortRef.current?.abort();
      catalogAbortRef.current = null;
    },
    []
  );

  const requestClose = useCallback(() => {
    checkoutAttemptRef.current += 1;
    checkoutAbortRef.current?.abort();
    checkoutAbortRef.current = null;
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = null;
    checkoutInFlightRef.current = false;
    setRedirecting(null);
    onCloseRef.current();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let alive = true;
    const controller = new AbortController();
    catalogAbortRef.current?.abort();
    catalogAbortRef.current = controller;
    setPackages(null);
    setCatalogVerified(false);
    // Bypass the shared TTL whenever this payment surface opens. The bundled
    // catalog may still render as display copy, but it never enables checkout.
    loadStoreCatalog({ force: true, signal: controller.signal })
      .then((catalog) => {
        if (
          !alive ||
          controller.signal.aborted ||
          !activeOwnerRef.current.isOpen ||
          activeOwnerRef.current.userId !== (user?.id ?? null) ||
          activeOwnerRef.current.returnParams !== returnParams
        )
          return;
        const displayPackages = displayPackagesFrom(catalog);
        const verifiedPackages = verifiedPackagesFrom(catalog);
        setPackages(displayPackages ?? []);
        setCatalogVerified(Boolean(verifiedPackages));
      })
      .catch(() => {
        if (!alive || controller.signal.aborted) return;
        setPackages([]);
        setCatalogVerified(false);
      });
    return () => {
      alive = false;
      controller.abort();
      if (catalogAbortRef.current === controller) catalogAbortRef.current = null;
    };
  }, [isOpen, returnParams, user?.id]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
    const focusFrame = window.requestAnimationFrame(() => {
      (focusable()[0] ?? dialogRef.current)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        requestClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = focusable();
      if (!controls.length) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = controls[0];
      const last = controls[controls.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [isOpen, requestClose]);

  if (!isOpen) return null;

  const handlePurchase = async (pkg: DiamondPackage) => {
    if (checkoutInFlightRef.current) return;
    if (!cardPaymentAvailable) {
      toast.error(NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE);
      return;
    }
    const selectedUserId = user?.id;
    const selectedPackages = verifiedPackagesFrom({
      fromServer: catalogVerified,
      diamondPackages: packages,
    });
    const selectedPackage = selectedPackages?.find((entry) => entry.id === pkg.id);
    if (!selectedUserId || !selectedPackage) {
      toast.error('Live Pricing Or Player Identity Is Temporarily Unavailable');
      return;
    }
    checkoutInFlightRef.current = true;
    setRedirecting(pkg.id);
    let purchaseScope: string | null = null;
    let purchaseRequestId: string | null = null;
    let purchaseWasResumed = false;
    const selectedReturnParams = returnParams;
    const attemptId = ++checkoutAttemptRef.current;
    checkoutAbortRef.current?.abort();
    const controller = new AbortController();
    checkoutAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      checkoutAttemptRef.current === attemptId &&
      activeOwnerRef.current.isOpen &&
      activeOwnerRef.current.userId === selectedUserId &&
      activeOwnerRef.current.returnParams === selectedReturnParams;
    try {
      // A second forced read is the payment authorization boundary. The offer
      // displayed above is only a snapshot and may have changed while open.
      const currentCatalog = await loadStoreCatalog({
        force: true,
        signal: controller.signal,
      });
      if (!attemptIsCurrent()) return;
      const currentPackages = verifiedPackagesFrom(currentCatalog);
      if (!currentPackages) {
        setPackages(displayPackagesFrom(currentCatalog) ?? []);
        setCatalogVerified(false);
        throw new Error('Live Pricing Could Not Be Verified. No Payment Was Started.');
      }
      setPackages(currentPackages);
      setCatalogVerified(true);
      const currentPackage = currentPackages.find((entry) => entry.id === selectedPackage.id);
      if (!currentPackage) {
        throw new Error('This Diamond Package Is No Longer Available. No Payment Was Started.');
      }
      if (!exactPackageTerms(selectedPackage, currentPackage)) {
        throw new Error('Pricing Was Updated. Review The Current Package Before Purchasing.');
      }
      const offerConfirmation = diamondCheckoutOfferConfirmation(selectedUserId, currentPackage);
      if (!offerConfirmation) {
        throw new Error('The Checkout Terms Could Not Be Verified. No Payment Was Started.');
      }

      purchaseScope = marketplacePurchaseScope(
        selectedUserId,
        'diamond-package-card',
        currentPackage.id
      );
      const purchaseIntent = readOrCreateMarketplacePurchaseIntent(
        purchaseScope,
        purchaseTermsKey(currentPackage)
      );
      purchaseRequestId = purchaseIntent.requestId;
      purchaseWasResumed = purchaseIntent.resumed;

      // startCheckout accepts navigation only when Stripe returns this exact
      // request id and Checkout Session, then uses the current browser surface.
      await startCheckout(
        'diamonds',
        [{ packageId: currentPackage.id, quantity: 1 }],
        selectedReturnParams,
        {
          requestId: purchaseIntent.requestId,
          expectedUserId: selectedUserId,
          offerConfirmation,
          signal: controller.signal,
        }
      );
    } catch (err: unknown) {
      if (!attemptIsCurrent()) return;
      if (
        purchaseScope &&
        purchaseRequestId &&
        (isVerifiedCheckoutTerminalExpiration(err) ||
          (!purchaseWasResumed && isVerifiedCheckoutPrecommitRefusal(err)))
      ) {
        if (!retireMarketplacePurchaseIntent(purchaseScope, purchaseRequestId)) {
          toast.warning(
            'Checkout Did Not Start, But Its Protected Recovery Record Changed And Was Not Cleared. Review The Pending Purchase Before Trying Again.'
          );
        }
      }
      toast.error(err instanceof Error ? err.message : 'Could Not Start Checkout');
    } finally {
      if (checkoutAbortRef.current === controller) {
        checkoutAbortRef.current = null;
        checkoutInFlightRef.current = false;
        setRedirecting(null);
      }
    }
  };

  return (
    <div className="diamond-modal-overlay" onClick={requestClose}>
      <div
        ref={dialogRef}
        className="diamond-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diamond-store-title"
        aria-describedby="diamond-store-description"
        aria-busy={redirecting !== null}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="diamond-modal__header">
          <div>
            <span className="diamond-modal__eyebrow">Secure Player Checkout</span>
            <h2 id="diamond-store-title">Add Diamonds</h2>
          </div>
          <button
            className="diamond-modal__close"
            onClick={requestClose}
            aria-label="Close Diamond Store"
          >
            Close
          </button>
        </div>

        <div className="diamond-modal__body">
          <p id="diamond-store-description" className="diamond-modal__desc">
            {cardPaymentAvailable
              ? 'Choose A Pack. Secure Checkout Confirms The Price Before Payment, Then Your Balance Updates From The Server.'
              : 'Diamond Packages Are Display Only In This Build. Use The Web Store To Purchase Diamonds.'}
          </p>

          {/* A catalog that could not be read is not an empty store. */}
          {packages === null ? (
            <div className="diamond-modal__loading" role="status">
              <span />
              Loading Secure Packages
            </div>
          ) : (
            <>
              {(!catalogVerified || !cardPaymentAvailable) && (
                <p className="diamond-modal__desc" role="alert">
                  {!cardPaymentAvailable
                    ? NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE
                    : 'Live Pricing Is Temporarily Unavailable. Packages Are Display Only Until Verification Returns.'}
                </p>
              )}
              <div className="diamond-modal__grid">
                {packages.map((pkg, index) => (
                  <div
                    key={pkg.id}
                    className={`diamond-package ${pkg.popular ? 'diamond-package--popular' : ''}`}
                  >
                    {pkg.popular && <span className="diamond-package__badge">Most Popular</span>}

                    <div className="diamond-package__amount">
                      <span
                        className="diamond-package__art"
                        data-tier={Math.min(Math.max(index, 0), 5)}
                        style={
                          {
                            '--diamond-package-atlas': `url(${DIAMOND_PACKAGE_ATLAS})`,
                          } as CSSProperties
                        }
                        aria-hidden="true"
                      />
                      <span className="diamond-package__diamond-copy">
                        <span className="diamond-package__diamonds">
                          {pkg.diamonds.toLocaleString()} Diamonds
                        </span>
                        {pkg.bonus > 0 && (
                          <span className="diamond-package__bonus">
                            +{pkg.bonus.toLocaleString()} Bonus
                          </span>
                        )}
                      </span>
                    </div>

                    <span className="diamond-package__name">{formatPopupText(pkg.name)}</span>

                    <button
                      className="diamond-package__btn"
                      onClick={() => handlePurchase(pkg)}
                      disabled={
                        redirecting !== null ||
                        !catalogVerified ||
                        !cardPaymentAvailable ||
                        !user?.id
                      }
                      aria-label={`Buy ${formatPopupText(pkg.name)}, ${(pkg.diamonds + pkg.bonus).toLocaleString()} Diamonds For $${pkg.priceUsd.toFixed(2)}`}
                    >
                      {/* DOLLARS, LABELLED AS DOLLARS. */}
                      {redirecting === pkg.id
                        ? 'Opening Checkout'
                        : cardPaymentAvailable
                          ? `$${pkg.priceUsd.toFixed(2)}`
                          : 'Checkout Paused'}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="diamond-modal__trust" aria-label="Checkout Assurances">
          <span>{cardPaymentAvailable ? 'Secure Checkout' : 'Web Checkout Available'}</span>
          <span>Server-Priced</span>
          <span>Permanent Balance</span>
        </div>
      </div>
    </div>
  );
}

export default DiamondTopUpModal;
