import { useCallback, useContext, useLayoutEffect, useRef } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

/** Keep a funded bonus mounted until it has an authoritative terminal result.
 * Browser/app termination cannot be forbidden; the existing receipt owns recovery.
 *
 * Returns a stable release. A release lasts until the hold is next armed: the
 * wheel releases in the same callback that navigates to the won game, and a
 * render in between must not re-arm the hold it just let go of. */
export function useLiveBonusGuard(active: boolean, onBlocked: () => void) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const released = useRef(false);
  if (!active) released.current = false;
  const held = active && !released.current;
  const current = useRef({ active: held, onBlocked });
  current.current = { active: held, onBlocked };
  // The history position a blocked back/forward is restored to. Re-anchored
  // each time the hold is armed, so a URL change between rounds (a replace
  // that strips a query, a pushed sub-view) cannot leave it stale.
  const anchor = useRef<{ index: unknown; url: string; state: unknown }>({
    index: undefined,
    url: '',
    state: null,
  });
  useLayoutEffect(() => {
    if (held)
      anchor.current = {
        index: window.history.state?.idx,
        url: window.location.href,
        state: window.history.state,
      };
  }, [held]);
  useLayoutEffect(() => {
    const push = navigator.push,
      replace = navigator.replace,
      go = navigator.go;
    const refuse = () => {
      if (!current.current.active) return false;
      current.current.onBlocked();
      return true;
    };
    navigator.push = (...args) => {
      if (!refuse()) push.apply(navigator, args);
    };
    navigator.replace = (...args) => {
      if (!refuse()) replace.apply(navigator, args);
    };
    navigator.go = (...args) => {
      if (!refuse()) go.apply(navigator, args);
    };
    let restoring = false;
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        event.stopImmediatePropagation();
        restoring = false;
        return;
      }
      if (!current.current.active) return;
      // A capture listener on window runs before the router's bubble listener
      // for an event dispatched at window, so the game never unmounts.
      event.stopImmediatePropagation();
      current.current.onBlocked();
      const { index, url, state } = anchor.current;
      const next = window.history.state?.idx;
      if (Number.isInteger(index) && Number.isInteger(next) && index !== next) {
        restoring = true;
        window.history.go((index as number) - (next as number));
      } else window.history.pushState(state, '', url);
    };
    const click = (event: MouseEvent) => {
      const anchorElement =
        event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (anchorElement && current.current.active) {
        event.preventDefault();
        event.stopImmediatePropagation();
        current.current.onBlocked();
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (current.current.active) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('popstate', pop, true);
    document.addEventListener('click', click, true);
    window.addEventListener('beforeunload', unload);
    return () => {
      navigator.push = push;
      navigator.replace = replace;
      navigator.go = go;
      window.removeEventListener('popstate', pop, true);
      document.removeEventListener('click', click, true);
      window.removeEventListener('beforeunload', unload);
    };
  }, [navigator]);
  return useCallback(() => {
    released.current = true;
    current.current.active = false;
  }, []);
}
