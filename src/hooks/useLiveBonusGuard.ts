import { useContext, useLayoutEffect, useRef } from 'react';
import { UNSAFE_NavigationContext } from 'react-router-dom';

/** Keep a funded bonus mounted until it has an authoritative terminal result.
 * Browser/app termination cannot be forbidden; the existing receipt owns recovery. */
export function useLiveBonusGuard(active: boolean, onBlocked: () => void) {
  const { navigator } = useContext(UNSAFE_NavigationContext);
  const current = useRef({ active, onBlocked });
  current.current = { active, onBlocked };
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
    const index = window.history.state?.idx;
    const url = window.location.href;
    const state = window.history.state;
    const pop = (event: PopStateEvent) => {
      if (restoring) {
        event.stopImmediatePropagation();
        restoring = false;
        return;
      }
      if (!current.current.active) return;
      // Capture precedes BrowserRouter's bubble listener, so the game never unmounts.
      event.stopImmediatePropagation();
      current.current.onBlocked();
      const next = window.history.state?.idx;
      if (Number.isInteger(index) && Number.isInteger(next) && index !== next) {
        restoring = true;
        window.history.go(index - next);
      } else window.history.pushState(state, '', url);
    };
    const click = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (anchor && current.current.active) {
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
  return () => {
    current.current.active = false;
  };
}
