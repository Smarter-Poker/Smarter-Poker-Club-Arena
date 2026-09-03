/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  USE IS MOUNTED — Standardized mount-state tracking hook
 * ═══════════════════════════════════════════════════════════════════════════════
 * Returns a ref that is `true` while the component is mounted and `false`
 * after unmount. Handles React StrictMode double-mount correctly by resetting
 * the ref to `true` in the effect body.
 *
 * Usage:
 *   const isMounted = useIsMounted();
 *   // In async callback:
 *   if (!isMounted.current) return;
 *   setState(newValue);
 */

import { useEffect, useRef } from 'react';

export function useIsMounted() {
  const isMounted = useRef(true);

  useEffect(() => {
    // Reset to true on mount (handles React StrictMode double-mount)
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  return isMounted;
}
