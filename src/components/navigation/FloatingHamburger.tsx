/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOATING HAMBURGER BUTTON — Always-visible navigation trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Fixed-position circular button that opens the HamburgerMenu drawer.
 * Renders on ALL pages regardless of iframe mode, ensuring users always
 * have access to settings, navigation, and options.
 *
 * Position: Bottom-right corner (bumps up when ClubBottomNav is present)
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import HamburgerMenu from './HamburgerMenu';
import styles from './FloatingHamburger.module.css';

// Routes where the floating button should not appear
const HIDDEN_ROUTES = ['/auth', '/share/'];

// Routes where ClubBottomNav is rendered (need extra bottom offset)
const BOTTOM_NAV_ROUTE_PATTERN = /^\/clubs\/[^/]+$/;

export default function FloatingHamburger() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Don't render on auth or share pages
  const shouldHide = HIDDEN_ROUTES.some((r) => location.pathname.startsWith(r));
  if (shouldHide) return null;

  // Don't render on table pages (full-screen immersive experience)
  if (location.pathname.startsWith('/table/')) return null;

  // Detect if ClubBottomNav is likely present (club home pages)
  const hasBottomNav = BOTTOM_NAV_ROUTE_PATTERN.test(location.pathname);

  return (
    <>
      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />

      <button
        className={`${styles.floatingButton} ${hasBottomNav ? styles.withBottomNav : ''}`}
        onClick={() => setMenuOpen(true)}
        aria-label="Open Menu"
        id="floating-hamburger-btn"
      >
        {/* Three-line hamburger icon */}
        <svg
          className={styles.icon}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      </button>
    </>
  );
}
