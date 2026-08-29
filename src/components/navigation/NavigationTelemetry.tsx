import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { capture } from '../../lib/analytics';

/**
 * Route health telemetry complements WebVitals: it records which audited
 * surface was reached and how long React took to produce two painted frames
 * after the route committed. No query values or player-entered text leave the
 * browser.
 */
export default function NavigationTelemetry() {
  const location = useLocation();
  const workspace = useClubWorkspace();
  const previousPathRef = useRef<string | null>(null);

  useEffect(() => {
    const startedAt = performance.now();
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        capture('club_arena_route_viewed', {
          route: location.pathname,
          previous_route: previousPathRef.current,
          club_id: workspace.clubUUID,
          route_paint_ms: Math.round(performance.now() - startedAt),
          offline: workspace.isOffline,
        });
        previousPathRef.current = location.pathname;
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame) cancelAnimationFrame(secondFrame);
    };
  }, [location.pathname, workspace.clubUUID, workspace.isOffline]);

  return null;
}
