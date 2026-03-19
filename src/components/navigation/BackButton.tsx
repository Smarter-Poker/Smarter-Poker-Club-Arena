/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * BACK BUTTON — Global header back navigation
 * ═══════════════════════════════════════════════════════════════════════════════
 * Renders a chevron-left back arrow that navigates to the previous page.
 * Automatically hides on root pages where back navigation is meaningless.
 *
 * CRITICAL: Uses a navigation-key sentinel to detect whether the user has
 * in-app history. If they opened a deep link directly (no prior SPA nav),
 * navigate(-1) would exit the app entirely — so we fall back to "/" instead.
 */

import { useNavigate, useLocation } from 'react-router-dom';
import { useRef, useEffect } from 'react';
import styles from './BackButton.module.css';

/** Pages where the back button should NOT appear */
const HIDDEN_PATHS = new Set(['/', '/auth']);

/**
 * Session-level counter of in-app navigations.
 * Starts at 0 when first loaded. Incremented on every pathname change.
 * If 0 on a sub-page, the user arrived via direct URL — navigate(-1) is unsafe.
 */
let inAppNavCount = 0;

export default function BackButton() {
  const navigate = useNavigate();
  const location = useLocation();
  const prevPathRef = useRef(location.pathname);

  // Track in-app navigations: each pathname change within the SPA increments
  useEffect(() => {
    if (prevPathRef.current !== location.pathname) {
      inAppNavCount++;
      prevPathRef.current = location.pathname;
    }
  }, [location.pathname]);

  // Hide on root/auth pages
  if (HIDDEN_PATHS.has(location.pathname)) {
    return null;
  }

  const handleBack = () => {
    if (inAppNavCount > 0) {
      // User has in-app history — safe to go back
      navigate(-1);
    } else {
      // Fresh tab / direct URL — go to home instead of exiting the app
      navigate('/', { replace: true });
    }
  };

  return (
    <button className={styles.backBtn} onClick={handleBack} aria-label="Go Back" title="Go Back">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
  );
}
