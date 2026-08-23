/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PERSISTENT TABLE LAYER — live tables survive EVERY route
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-19: MultiTablePage used to be the /table/:tableId ROUTE ELEMENT,
 * so any navigation outside /table/* — bottom nav, cashier, club switcher,
 * even a link inside the embedded lobby tab — unmounted the whole container
 * and closed every live engine socket. Recovery was only the server-truth
 * rebuild on return, mid-hand state lost.
 *
 * The container is now mounted HERE, once, as a SIBLING of <Routes> in
 * App.tsx, so no route change can unmount it:
 * - On /table/* it renders full-screen exactly as before (the route element
 *   itself renders null and only claims the path + auth redirect).
 * - Anywhere else MultiTablePage collapses itself to display:none — every
 *   TablePage stays mounted and every EngineStateClient (owned by TablePage
 *   via useEngineTableState) stays connected — and the global LiveTablesBar
 *   dock surfaces "Return to game" / "Action needed" instead.
 *
 * Gated on auth: unauthenticated visitors mount nothing here (the /table
 * route's AuthGuard still redirects them to /auth).
 */

import { Suspense } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import ErrorBoundary from '../common/ErrorBoundary';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

const MultiTablePage = lazyWithRetry(() => import('../../pages/MultiTablePage'));

export default function PersistentTableLayer() {
  const { user } = useAuthUser();
  const location = useLocation();
  const onTableRoute = matchPath('/table/:tableId', location.pathname) !== null;

  if (!user) return null;

  return (
    <ErrorBoundary
      // A crash in the (hidden) table layer must never paint a full-screen
      // error over whatever page the player is actually browsing; on /table/*
      // itself the default error UI is the right thing to show.
      fallback={onTableRoute ? undefined : <span style={{ display: 'none' }} />}
    >
      <Suspense
        fallback={
          onTableRoute ? (
            // Chunk still loading on a direct /table deep link: hold the
            // table backdrop color so there is no white flash.
            <div style={{ position: 'fixed', inset: 0, background: '#0a0c12', zIndex: 1 }} />
          ) : null
        }
      >
        <MultiTablePage />
      </Suspense>
    </ErrorBoundary>
  );
}
