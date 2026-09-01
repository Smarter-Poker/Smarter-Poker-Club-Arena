/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * FLOATING HAMBURGER BUTTON — Bottom-left companion trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is a SECONDARY trigger that emits a bus event to open the
 * single HamburgerMenu instance owned by GlobalHeader.
 * It does NOT render its own HamburgerMenu (prevents dual-instance bug).
 *
 * Auto-hides when the HamburgerMenu is open (via MENU_STATE_CHANGED bus event).
 * Position: Bottom-left corner (always visible except on table/auth pages)
 */

import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import styles from './FloatingHamburger.module.css';
import { CommandGridIcon } from './CommandGridIcon';

// Routes where the floating button should not appear
const HIDDEN_ROUTES = ['/auth', '/share/'];

export default function FloatingHamburger() {
  const location = useLocation();
  const [menuIsOpen, setMenuIsOpen] = useState(false);

  // Hide when the HamburgerMenu is open (emitted by GlobalHeader)
  useMasterBusSubscription('MENU_STATE_CHANGED', (payload) => {
    setMenuIsOpen(payload.isOpen);
  });

  // Don't render on auth or share pages
  const shouldHide = HIDDEN_ROUTES.some((r) => location.pathname.startsWith(r));
  if (shouldHide) return null;

  // Don't render on table pages (full-screen immersive experience)
  if (location.pathname.startsWith('/table/')) return null;

  const handleClick = () => {
    masterBus.emit('HAMBURGER_TOGGLE', {});
  };

  return (
    <button
      className={`${styles.floatingButton} ${menuIsOpen ? styles.hidden : ''}`}
      style={menuIsOpen ? { display: 'none' } : undefined}
      onClick={handleClick}
      aria-label="Open Menu"
      id="floating-hamburger-btn"
    >
      <CommandGridIcon className={styles.icon} />
    </button>
  );
}
