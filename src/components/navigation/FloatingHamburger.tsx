/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOATING HAMBURGER BUTTON — Always-visible navigation trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Fixed-position silver metallic hamburger button (no background).
 * Opens the HamburgerMenu drawer. Renders on ALL pages, ensuring
 * users always have access to settings, navigation, and options.
 *
 * Position: Top-left corner
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import HamburgerMenu from './HamburgerMenu';
import styles from './FloatingHamburger.module.css';

// Routes where the floating button should not appear
const HIDDEN_ROUTES = ['/auth', '/share/'];

export default function FloatingHamburger() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  // Don't render on auth or share pages
  const shouldHide = HIDDEN_ROUTES.some((r) => location.pathname.startsWith(r));
  if (shouldHide) return null;

  // Don't render on table pages (full-screen immersive experience)
  if (location.pathname.startsWith('/table/')) return null;

  return (
    <>
      <HamburgerMenu isOpen={menuOpen} onClose={() => setMenuOpen(false)} />

      {!menuOpen && (
        <button
          className={styles.floatingButton}
          onClick={() => setMenuOpen(true)}
          aria-label="Open Menu"
          id="floating-hamburger-btn"
        >
          {/* Silver metallic hamburger icon */}
          <svg className={styles.icon} viewBox="0 0 24 24" fill="none">
            <defs>
              <linearGradient id="silverGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#e8ecf0" />
                <stop offset="35%" stopColor="#c8ccd0" />
                <stop offset="65%" stopColor="#9aa0a8" />
                <stop offset="100%" stopColor="#d0d4d8" />
              </linearGradient>
            </defs>
            <rect x="3" y="4" width="18" height="2.5" rx="1.25" fill="url(#silverGrad)" />
            <rect x="3" y="10.75" width="18" height="2.5" rx="1.25" fill="url(#silverGrad)" />
            <rect x="3" y="17.5" width="18" height="2.5" rx="1.25" fill="url(#silverGrad)" />
          </svg>
        </button>
      )}
    </>
  );
}
