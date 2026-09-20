/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND STORE : Full-page redesign (2026-08-25)
 *
 *  Replaces the plain card grid with the cinematic sci-fi design from the
 *  uploaded reference image. Every package card starts the verified Card
 *  provider for its platform in the same app or browser surface. Nav tabs link
 *  to actual landing pages on smarter.poker rather than opening a modal.
 *
 *  Mobile-first: single-column stack on ≤ 480 px, 2-col grid on wider.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { leaveForHub } from '../../lib/openExternal';
import { formatPopupText } from '../../utils/popupStyle';
import {
  diamondCheckoutOfferConfirmation,
  isVerifiedCheckoutPrecommitRefusal,
  isVerifiedCheckoutTerminalExpiration,
  checkoutProviderReadyForCurrentPlatform,
  marketplacePurchaseScope,
  readOrCreateMarketplacePurchaseIntent,
  retireMarketplacePurchaseIntent,
  startCheckout,
  NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE,
  type DiamondPackage,
  type StoreCatalog,
  type WalletInfo,
} from './marketplaceShared';
import styles from './DiamondsTab.module.css';

const DIAMOND_PACKAGE_ATLAS = `${import.meta.env.BASE_URL}images/marketplace/diamond-packages/diamond-package-atlas-v1.webp`;

/* Navigation destinations stay in the current app page. */
const NAV_LINKS = [
  { label: 'VIP Membership', href: '/marketplace?tab=membership', destination: 'arena' },
  { label: 'Merch Store', href: '/hub/merch-store', destination: 'hub' },
  { label: 'Smarter Rewards', href: '/hub/smarter-rewards', destination: 'hub' },
  { label: 'Club Shop', href: '/marketplace?tab=store', destination: 'arena' },
] as const;

function DiamondPackageArt({ tier }: { tier: number }) {
  return (
    <span
      className={styles.packageArt}
      data-tier={Math.min(Math.max(tier, 0), 5)}
      style={{ '--diamond-package-atlas': `url(${DIAMOND_PACKAGE_ATLAS})` } as CSSProperties}
      aria-hidden="true"
    />
  );
}

interface DiamondsTabProps {
  clubId: string;
  userId: string;
  wallet: WalletInfo;
  packages: DiamondPackage[];
  /** True only after the server confirms the current package and price table. */
  catalogVerified: boolean;
  /** Bypasses the catalog TTL immediately before a payment is authorized. */
  refreshCatalogForPurchase: () => Promise<StoreCatalog>;
  /** Where to offer the player onward after a successful purchase (phase 3). */
  nextPath?: string | null;
}

export default function DiamondsTab({
  clubId,
  userId,
  wallet,
  packages,
  catalogVerified,
  refreshCatalogForPurchase,
  nextPath,
}: DiamondsTabProps) {
  const toast = useToast();
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const checkoutInFlightRef = useRef(false);
  const activeOwnerRef = useRef({ userId, clubId });
  const checkoutAttemptRef = useRef(0);
  const checkoutAbortRef = useRef<AbortController | null>(null);
  const cardPaymentAvailable = checkoutProviderReadyForCurrentPlatform('diamonds');

  useLayoutEffect(() => {
    activeOwnerRef.current = { userId, clubId };
    checkoutAttemptRef.current += 1;
    checkoutAbortRef.current?.abort();
    checkoutAbortRef.current = null;
    checkoutInFlightRef.current = false;
    setRedirecting(null);
  }, [clubId, userId]);

  useEffect(
    () => () => {
      checkoutAttemptRef.current += 1;
      checkoutAbortRef.current?.abort();
      checkoutAbortRef.current = null;
    },
    []
  );

  /* ── Stripe checkout ───────────────────────────────────────────────────── */
  const handleBuy = async (pkg: DiamondPackage) => {
    if (checkoutInFlightRef.current) return;
    if (!cardPaymentAvailable) {
      toast.error(NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE);
      return;
    }
    if (!catalogVerified) {
      toast.error('Live Pricing Is Temporarily Unavailable');
      return;
    }
    checkoutInFlightRef.current = true;
    setRedirecting(pkg.id);
    let purchaseScope: string | null = null;
    let purchaseRequestId: string | null = null;
    let purchaseWasResumed = false;
    const attemptId = ++checkoutAttemptRef.current;
    checkoutAbortRef.current?.abort();
    const controller = new AbortController();
    checkoutAbortRef.current = controller;
    const attemptIsCurrent = () =>
      !controller.signal.aborted &&
      checkoutAttemptRef.current === attemptId &&
      activeOwnerRef.current.userId === userId &&
      activeOwnerRef.current.clubId === clubId;
    try {
      const currentCatalog = await refreshCatalogForPurchase();
      if (!attemptIsCurrent()) return;
      const currentPackage = currentCatalog.diamondPackages.find((entry) => entry.id === pkg.id);
      if (!currentCatalog.fromServer || !currentPackage) {
        throw new Error('Live Pricing Could Not Be Verified. No Payment Was Started.');
      }
      if (
        currentPackage.diamonds !== pkg.diamonds ||
        currentPackage.bonus !== pkg.bonus ||
        currentPackage.priceUsd !== pkg.priceUsd
      ) {
        throw new Error('Pricing Was Updated. Review The Current Package Before Purchasing.');
      }
      const offerConfirmation = diamondCheckoutOfferConfirmation(userId, currentPackage);
      if (!offerConfirmation) {
        throw new Error('The Checkout Terms Could Not Be Verified. No Payment Was Started.');
      }
      purchaseScope = marketplacePurchaseScope(userId, 'diamond-package-card', currentPackage.id);
      const purchaseIntent = readOrCreateMarketplacePurchaseIntent(
        purchaseScope,
        JSON.stringify({
          version: 1,
          type: 'diamonds',
          packageId: currentPackage.id,
          quantity: 1,
          diamonds: currentPackage.diamonds,
          bonus: currentPackage.bonus,
          priceUsd: currentPackage.priceUsd,
          priceCents: currentPackage.priceCents,
        })
      );
      purchaseRequestId = purchaseIntent.requestId;
      purchaseWasResumed = purchaseIntent.resumed;
      await startCheckout(
        'diamonds',
        [{ packageId: currentPackage.id, quantity: 1 }],
        `club=${encodeURIComponent(clubId)}&tab=diamonds${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ''}`,
        {
          requestId: purchaseIntent.requestId,
          expectedUserId: userId,
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
      // Native StoreKit/Play purchase and cancel flows navigate inside the SPA
      // and return here. Release the synchronous latch on every result so one
      // completed sheet cannot leave every package disabled until unmount.
      if (checkoutAbortRef.current === controller) {
        checkoutAbortRef.current = null;
        checkoutInFlightRef.current = false;
        setRedirecting(null);
      }
    }
  };

  /* ── Packages to display (prefer server catalog, fall back to prop) ──── */
  const visiblePackages = packages.length > 0 ? packages : [];

  return (
    <div className={styles.root}>
      {/* ── Title ──────────────────────────────────────────────────────── */}
      <div className={styles.titleRow}>
        <span className={styles.eyebrow}>Secure Club Arena Currency</span>
        <h2 className={styles.title}>Diamond Vault</h2>
        <p className={styles.titleSub}>
          Choose A Bundle. Your Wallet Updates After Payment Clears.
        </p>
      </div>

      {(!catalogVerified || !cardPaymentAvailable) && (
        <p className={styles.catalogNotice} role="alert">
          {!cardPaymentAvailable
            ? NATIVE_MARKETPLACE_PAYMENT_HOLD_MESSAGE
            : 'Live Pricing Is Temporarily Unavailable. Packages Are Display Only Until Verification Returns.'}
        </p>
      )}

      {/* ── Navigation tabs ────────────────────────────────────────────── */}
      <nav className={styles.navBar} aria-label="Diamond Store Navigation">
        {NAV_LINKS.map((link) => {
          const content = <span className={styles.navLabel}>{link.label}</span>;
          return link.destination === 'hub' ? (
            <button
              type="button"
              key={link.href}
              className={styles.navTab}
              onClick={() => leaveForHub(link.href)}
            >
              {content}
            </button>
          ) : (
            <Link key={link.href} to={link.href} className={styles.navTab}>
              {content}
            </Link>
          );
        })}
      </nav>

      {/* ── Promo banner ───────────────────────────────────────────────── */}
      <div className={styles.promoBanner}>
        <p className={styles.promoBody}>
          Purchase Diamonds For Cash Games, Tournaments, VIP Perks, Exclusive Rewards, And Premium
          Smarter.Poker Upgrades.
        </p>
        <p className={styles.promoBonus}>5% Bonus Diamonds On $100+ Purchases</p>
      </div>

      {/* ── Wallet balance ─────────────────────────────────────────────── */}
      {wallet.loaded && (
        <p className={styles.balance} aria-live="polite">
          Current Balance: <strong>{wallet.diamonds.toLocaleString()} Diamonds</strong>
        </p>
      )}

      {/* ── Package grid ───────────────────────────────────────────────── */}
      <div className={styles.grid}>
        {visiblePackages.map((pkg, idx) => {
          const isRedirecting = redirecting === pkg.id;
          const disabled = redirecting !== null || !catalogVerified || !cardPaymentAvailable;
          const totalDiamonds = pkg.diamonds + pkg.bonus;

          return (
            /* The entire card is a button-like area : clicking anywhere buys */
            <button
              key={pkg.id}
              className={`${styles.card} ${pkg.popular ? styles.cardPopular : ''} ${disabled ? styles.cardDisabled : ''}`}
              onClick={() => handleBuy(pkg)}
              disabled={disabled}
              aria-label={`Buy ${totalDiamonds.toLocaleString()} Diamonds For $${pkg.priceUsd.toFixed(2)}`}
              aria-busy={isRedirecting}
            >
              {pkg.popular && <span className={styles.popularBadge}>Popular</span>}
              {pkg.bonus > 0 && (
                <span className={styles.bonusBadge}>+{pkg.bonus.toLocaleString()} Bonus!</span>
              )}

              <div className={styles.cardInner}>
                {/* Gem art */}
                <div className={styles.gemWrap}>
                  <DiamondPackageArt tier={idx} />
                </div>

                {/* Package info */}
                <div className={styles.pkgInfo}>
                  <span className={styles.pkgLabel}>Diamonds</span>
                  <span className={styles.pkgAmount}>{totalDiamonds.toLocaleString()}</span>
                  <span className={styles.pkgSub}>
                    {formatPopupText(pkg.name)} - ${pkg.priceUsd.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Direct, secure checkout CTA */}
              <div className={styles.ctaRow}>
                <span className={styles.ctaBtn}>
                  {isRedirecting
                    ? 'Opening Checkout'
                    : cardPaymentAvailable
                      ? 'Buy Securely'
                      : 'App Store Checkout Paused'}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Footer note ────────────────────────────────────────────────── */}
      <p className={styles.footNote}>
        {cardPaymentAvailable
          ? 'Secure Checkout · Balance Updates Automatically After Payment'
          : 'Web Checkout Remains Available At Smarter.Poker'}
      </p>
    </div>
  );
}
