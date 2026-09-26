import { useEffect, useState } from 'react';

/**
 * A phone on its side (2026-09-26). The same query GameConsole.module.css
 * lays the console out beside its scene with; keep the two identical.
 */
export const SHORT_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px)';

/**
 * How tall a game scene may be on a phone held sideways, so the scene and both
 * console plates fit one screen; null in every other shape, where the scene
 * keeps the size its page gives it.
 *
 * The number is the console's own `--scene-budget` (GameConsole.module.css:
 * the viewport less the console header, the playfield's padding and the home
 * indicator's safe area), read by laying one probe into the console, so the
 * stylesheet stays the single source of it. Before the console has mounted the
 * probe reads the root instead, and the viewport less a header stands in.
 */
export function useSceneBudget(): number | null {
  const [budget, setBudget] = useState<number | null>(readBudget);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(SHORT_LANDSCAPE_QUERY);
    const update = () => setBudget(readBudget());
    update();
    window.addEventListener('resize', update);
    query.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('resize', update);
      query.removeEventListener?.('change', update);
    };
  }, []);
  return budget;
}

function readBudget(): number | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (!window.matchMedia(SHORT_LANDSCAPE_QUERY).matches) return null;
  const host = document.querySelector('[data-game-console]');
  if (!host) return Math.max(0, Math.floor(window.innerHeight - 64));
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--scene-budget, 0px)';
  host.appendChild(probe);
  const height = probe.getBoundingClientRect().height;
  probe.remove();
  return height > 0 ? Math.floor(height) : Math.max(0, Math.floor(window.innerHeight - 64));
}
