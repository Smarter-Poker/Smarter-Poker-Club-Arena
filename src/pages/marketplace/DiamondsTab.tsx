/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  DIAMOND STORE — Full-page redesign (2026-08-25)
 *
 *  Replaces the plain card grid with the cinematic sci-fi design from the
 *  uploaded reference image.  Every package card is fully clickable and
 *  redirects to Stripe Checkout (no popup).  Nav tabs link to actual landing
 *  pages on smarter.poker rather than opening a modal.
 *
 *  Mobile-first: single-column stack on ≤ 480 px, 2-col grid on wider.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useToast } from '../../components/common/Toast';
import { startCheckout, uuid, type DiamondPackage, type WalletInfo } from './marketplaceShared';
import styles from './DiamondsTab.module.css';

/* ── Nav-tab destination URLs ────────────────────────────────────────────── */
const NAV_LINKS = [
  { label: 'VIP Membership', icon: '♛', href: '/marketplace?tab=membership' },
  { label: 'Merch', icon: '◈', href: 'https://smarter.poker/merch' },
  { label: 'Smarter Rewards', icon: '★', href: 'https://smarter.poker/rewards' },
  { label: 'Club Arena', icon: '♠', href: '/marketplace?tab=store' },
] as const;

/* ── Tier config: maps package index → visual tier ──────────────────────── */
const TIER_SIZES: Array<'sm' | 'md' | 'lg'> = ['sm', 'sm', 'md', 'md', 'lg', 'lg'];

interface DiamondsTabProps {
  clubId: string;
  wallet: WalletInfo;
  packages: DiamondPackage[];
  /** Where to offer the player onward after a successful purchase (phase 3). */
  nextPath?: string | null;
}

export default function DiamondsTab({ clubId, wallet, packages, nextPath }: DiamondsTabProps) {
  const toast = useToast();
  const [redirecting, setRedirecting] = useState<string | null>(null);
  const checkoutInFlightRef = useRef(false);
  const checkoutKeyRef = useRef<string | null>(null);

  /* ── Stripe checkout ───────────────────────────────────────────────────── */
  const handleBuy = async (pkg: DiamondPackage) => {
    if (checkoutInFlightRef.current) return;
    checkoutInFlightRef.current = true;
    checkoutKeyRef.current = uuid();
    setRedirecting(pkg.id);
    try {
      await startCheckout(
        'diamonds',
        [{ packageId: pkg.id, quantity: 1 }],
        `club=${encodeURIComponent(clubId)}&tab=diamonds${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ''}`,
        checkoutKeyRef.current
      );
      // startCheckout navigates away on success — the line below only runs on error.
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Could not start checkout');
      checkoutInFlightRef.current = false;
      checkoutKeyRef.current = null;
      setRedirecting(null);
    }
  };

  /* ── Diamond SVG gem (inline, no external dep) ─────────────────────────── */
  const DiamondGem = ({ size }: { size: 'sm' | 'md' | 'lg' }) => {
    const px = size === 'lg' ? 72 : size === 'md' ? 56 : 44;
    return (
      <svg
        width={px}
        height={px}
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        className={styles.gem}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="gemTop" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a8e6ff" />
            <stop offset="100%" stopColor="#2196f3" />
          </linearGradient>
          <linearGradient id="gemLeft" x1="1" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1565c0" />
            <stop offset="100%" stopColor="#0d2f6e" />
          </linearGradient>
          <linearGradient id="gemRight" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1976d2" />
            <stop offset="100%" stopColor="#0a1f50" />
          </linearGradient>
          <filter id="gemGlow">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* top facet */}
        <polygon points="50,5 20,38 80,38" fill="url(#gemTop)" filter="url(#gemGlow)" />
        {/* left facet */}
        <polygon points="20,38 50,95 50,38" fill="url(#gemLeft)" />
        {/* right facet */}
        <polygon points="80,38 50,38 50,95" fill="url(#gemRight)" />
        {/* sparkle */}
        <circle cx="35" cy="22" r="4" fill="white" opacity="0.7" />
        <circle cx="62" cy="18" r="2" fill="white" opacity="0.5" />
      </svg>
    );
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

      {/* ── Navigation tabs ────────────────────────────────────────────── */}
      <nav className={styles.navBar} aria-label="Diamond Store Navigation">
        {NAV_LINKS.map((link) => {
          const content = (
            <>
              <span className={styles.navIcon}>{link.icon}</span>
              <span className={styles.navLabel}>{link.label}</span>
            </>
          );
          return link.href.startsWith('http') ? (
            <a
              key={link.href}
              href={link.href}
              className={styles.navTab}
              target="_blank"
              rel="noopener noreferrer"
            >
              {content}
            </a>
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
          const tier = TIER_SIZES[Math.min(idx, TIER_SIZES.length - 1)];
          const isRedirecting = redirecting === pkg.id;
          const disabled = redirecting !== null;
          const totalDiamonds = pkg.diamonds + pkg.bonus;

          return (
            /* The entire card is a button-like area — clicking anywhere buys */
            <button
              key={pkg.id}
              className={`${styles.card} ${pkg.popular ? styles.cardPopular : ''} ${disabled ? styles.cardDisabled : ''}`}
              onClick={() => handleBuy(pkg)}
              disabled={disabled}
              aria-label={`Buy ${totalDiamonds.toLocaleString()} Diamonds For $${pkg.priceUsd.toFixed(2)}`}
              aria-busy={isRedirecting}
            >
              {pkg.popular && <span className={styles.popularBadge}>POPULAR</span>}
              {pkg.bonus > 0 && (
                <span className={styles.bonusBadge}>+{pkg.bonus.toLocaleString()} Bonus!</span>
              )}

              <div className={styles.cardInner}>
                {/* Gem art */}
                <div className={styles.gemWrap}>
                  <DiamondGem size={tier} />
                </div>

                {/* Package info */}
                <div className={styles.pkgInfo}>
                  <span className={styles.pkgLabel}>Diamonds</span>
                  <span className={styles.pkgAmount}>{totalDiamonds.toLocaleString()}</span>
                  <span className={styles.pkgSub}>
                    {pkg.name} - ${pkg.priceUsd.toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Direct, secure checkout CTA */}
              <div className={styles.ctaRow}>
                <span className={styles.ctaBtn}>
                  {isRedirecting ? 'Opening Checkout…' : 'Buy Securely'}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* ── Footer note ────────────────────────────────────────────────── */}
      <p className={styles.footNote}>
        Secure Checkout Via Stripe · Balance Updates Automatically After Payment
      </p>
    </div>
  );
}
