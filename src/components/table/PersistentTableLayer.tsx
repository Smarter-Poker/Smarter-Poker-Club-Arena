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

import { Suspense, useEffect } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import ErrorBoundary from '../common/ErrorBoundary';
import PortraitLock from './PortraitLock';
import { lazyWithRetry } from '../../utils/lazyWithRetry';

const MultiTablePage = lazyWithRetry(() => import('../../pages/MultiTablePage'));
/* Lazy for the same reason MultiTablePage is: this layer is imported by
   App.tsx, so a static import here lands in the ENTRY chunk that every
   player downloads before first paint (the CI entry-chunk guard refused six
   modules - the card, its CSS, the gate, the formatters - on 2026-09-05).
   The announcer mounts the moment a user is signed in, long before any
   jackpot could need it. */
const BBJHitAnnouncer = lazyWithRetry(() => import('../bbj/BBJHitAnnouncer'));

// Match TableRouteBoundary's full UUID shape without importing its club resolver
// and dependencies into the entry chunk. UUID versions do not restrict table IDs.
const TABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function PersistentTableLayer() {
  const { user } = useAuthUser();
  const location = useLocation();
  const tableRoute = matchPath('/table/:tableId', location.pathname);
  const onTableRoute = tableRoute !== null;
  const tableId = tableRoute?.params.tableId;
  const userId = user?.id;

  useEffect(() => {
    if (!userId || !tableId || !TABLE_ID_PATTERN.test(tableId)) return;
    let disposed = false;
    // Direct links have no lobby intent. Start the same speculative owner while
    // MultiTablePage is loading; the real table still owns admission and errors.
    // Keep this import dynamic: this layer itself is part of the entry chunk.
    void import('../../services/tableWarmup')
      .then(({ warmTable }) => {
        if (!disposed) warmTable(tableId);
      })
      .catch(() => {
        // Preparation is optional; failure must not block the actual table.
      });
    return () => {
      // A delayed chunk must not start work for an old route or account.
      disposed = true;
    };
  }, [tableId, userId]);

  if (!user) return null;

  return (
    <>
      {/* PORTRAIT LOCK (Dan 2026-08-28: "lock it, portrait mode only").
          It belongs HERE and nowhere else. MultiTablePage keeps up to four
          TablePages mounted at once, so anything rendered inside a table would
          paint four identical full-screen overlays and fire four orientation
          lock requests. This layer is the one place that is mounted exactly
          once and already knows whether a table is on screen — the same two
          properties the overlay needs. It is OUTSIDE the ErrorBoundary
          deliberately: if the table layer crashes while the phone is sideways,
          the instruction to turn it back is the last thing that should go. */}
      <PortraitLock active={onTableRoute} />
      {/* THE BAD BEAT JACKPOT POP-UP (BBJ audit 2026-09-05). Same argument as
          PortraitLock, one line up: it must appear exactly once, on top of
          whatever the player is looking at, and this is the component that is
          mounted exactly once. Inside a TablePage it was drawn four times over
          and, worse, consumed by whichever slot ran first - a hidden one, as
          often as not - so the visible table showed nothing. Outside the
          ErrorBoundary for the same reason PortraitLock is: a crash in the
          table layer must not take the jackpot announcement with it. */}
      <Suspense fallback={null}>
        <BBJHitAnnouncer />
      </Suspense>
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
    </>
  );
}
