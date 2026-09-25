import { useEffect } from 'react';

/** Keep the complete application shell unavailable behind a body-level dialog. */
export function useInertAppShell(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;
    const appRoot = document.getElementById('root');
    if (!appRoot) return undefined;
    const hadInert = appRoot.hasAttribute('inert');
    const previousAriaHidden = appRoot.getAttribute('aria-hidden');
    appRoot.setAttribute('inert', '');
    appRoot.setAttribute('aria-hidden', 'true');
    return () => {
      if (!hadInert) appRoot.removeAttribute('inert');
      if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden');
      else appRoot.setAttribute('aria-hidden', previousAriaHidden);
    };
  }, [active]);
}
