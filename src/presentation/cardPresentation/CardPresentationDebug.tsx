/**
 * RIVER SQUEEZE 2026-09-04 (spec 111) — operator debug overlay. DEVELOPMENT
 * ONLY: the whole component is behind import.meta.env.DEV at the call site,
 * so Vite drops it from the production bundle, and it only renders when the
 * page URL carries ?rsDebug. Shows every presentation the engine has in
 * flight: key, profile, phase, elapsed and expected ms. Never the card.
 */

import React, { useEffect, useState } from 'react';
import { cardPresentationEngine } from './engineSingleton';
import type { ActivePresentationView } from './CardPresentationEngine';

const POLL_MS = 50;

export function isCardPresentationDebugRequested(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return new URLSearchParams(window.location.search).has('rsDebug');
  } catch {
    return false;
  }
}

export function CardPresentationDebug({ boardIndex }: { boardIndex: number }) {
  const [views, setViews] = useState<ActivePresentationView[]>([]);
  useEffect(() => {
    const tick = () =>
      setViews(cardPresentationEngine.activeViews().filter((v) => v.boardIndex === boardIndex));
    const id = setInterval(tick, POLL_MS);
    const off = cardPresentationEngine.subscribe(tick);
    return () => {
      clearInterval(id);
      off();
    };
  }, [boardIndex]);
  if (views.length === 0) return null;
  return (
    <div
      className="community-cards__rs-debug"
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        zIndex: 1,
        font: '10px/1.3 monospace',
        color: '#fff',
        background: 'rgba(0,0,0,0.75)',
        padding: '2px 4px',
        whiteSpace: 'pre',
        pointerEvents: 'none',
      }}
    >
      {views
        .map(
          (v) => `${v.street} ${v.profile.id} ${v.phase} ${v.elapsedMs}/${v.expectedMs}ms\n${v.key}`
        )
        .join('\n')}
    </div>
  );
}
