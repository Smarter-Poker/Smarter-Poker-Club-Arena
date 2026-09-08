/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOS GUARD — blocks Club Arena until the Terms of Service are accepted
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS WAS. A passthrough:
 *
 *     export default function TOSGuard({ children }) { return <>{children}</>; }
 *
 * wrapped around the ENTIRE router in App.tsx, under a doc comment describing
 * everything it would do "when enabled". So the app read as gated and gated
 * nothing. The evidence, measured 2026-09-02:
 *
 *   * 0 of 1,308 profiles have `club_arena_tos_accepted_at` set. Not a low
 *     number - zero, since the column was added.
 *   * `ProfileService.getTOSStatus` and `acceptTOS` had no callers anywhere.
 *   * `TOSAcceptanceModal` - a complete, working, scroll-to-the-bottom modal -
 *     was imported by nothing.
 *   * `/api/club-arena/accept-tos` - a complete, working endpoint - was called
 *     by nothing (its only mention anywhere is a rate-limiter config entry).
 *
 * Every piece existed and none of them were connected. This connects them.
 *
 * ── WHY 'unknown' DOES NOT BLOCK ──────────────────────────────────────────
 *
 * `getTOSStatus` returns a TRI-state on purpose, and its own comment explains
 * why: "we asked and they have not accepted" and "we could not ask" are
 * different facts, and collapsing them is how the previous version treated a
 * network blip as consent.
 *
 * This guard reads that in the other direction. A blip must not be treated as
 * consent - and it does not, because nothing is recorded. But it also must not
 * lock all 1,308 accounts out of the whole application, which is what
 * fail-closed means when the gate wraps the entire router and the check is one
 * PostgREST read. So 'unknown' renders the app and re-checks on the next
 * navigation; the player is asked again the moment the read succeeds.
 *
 * THE UI IS NOT THE ENFORCEMENT BOUNDARY, and must never be mistaken for one.
 * A determined user can bypass any client-side gate. The durable boundary is
 * server-side: `World-Hub/pages/api/poker/engine/seat.js` already refuses
 * `sit_down` with `TOS_NOT_ACCEPTED` when a `clubId` is present. That path is
 * not the one Club Arena's felt currently uses, which is a real gap and is
 * called out in this PR - but the ORDER matters and this is the first half:
 * nobody can accept until something asks them, and enforcing at the seat
 * before acceptance exists would simply stop every human from sitting down.
 */

import { Suspense, lazy, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { reportError } from '../../utils/errorReporter';
import { uuid } from '../../utils/uuid';
/* LAZY on purpose. This guard wraps the entire router, so a static import
   here would put the whole acceptance modal and its stylesheet into the chunk
   every player downloads before first paint - and once a player has accepted,
   they never see it again. `entry-chunk-delta.mjs` is the CI guard that would
   catch that, and lazy-loading is its own recommended fix. The modal arrives
   only for the one state that needs it. */
const TOSAcceptanceModal = lazy(() => import('./TOSAcceptanceModal'));

interface TOSGuardProps {
  children: ReactNode;
}

type GateState = 'checking' | 'accepted' | 'not_accepted' | 'unknown';

/**
 * Routes that must stay reachable while the gate is up.
 *
 * A person being asked to accept terms has to be able to READ those terms,
 * and has to be able to leave. Blocking `/legal` behind the acceptance modal
 * would mean the only copy of the agreement is the one inside the modal, and
 * blocking `/auth` would trap an account that wants to sign out instead.
 */
const ALWAYS_REACHABLE = ['/legal', '/auth', '/help'];

function isAlwaysReachable(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return ALWAYS_REACHABLE.some((root) => path === root || path.startsWith(`${root}/`));
}

export default function TOSGuard({ children }: TOSGuardProps) {
  const { user, isHydrating } = useAuthUser();
  const location = useLocation();
  const [state, setState] = useState<GateState>('checking');

  useEffect(() => {
    if (!user?.id) {
      setState('checking');
      return;
    }
    let cancelled = false;
    /* Dynamic for the same reason the modal is lazy: ProfileService pulls its
       own dependency tree, and this guard sits above every route, so a static
       import here lands it in the entry chunk for every player on every load.
       The status read happens once per session; the 3kB it would add to first
       paint is not worth paying on every visit. */
    void import('../../services/ProfileService')
      .then(({ profileService }) => profileService.getTOSStatus(user.id))
      .then((status) => {
        if (!cancelled) setState(status);
      })
      .catch((error) => {
        /* getTOSStatus already reports and returns 'unknown' rather than
           throwing; this is belt-and-braces so a future change to it cannot
           turn a failed read into an unhandled rejection that leaves the gate
           stuck on 'checking' forever. */
        if (cancelled) return;
        reportError(error, 'TOSGuard.status_check_failed', { userId: user.id });
        setState('unknown');
      });
    return () => {
      cancelled = true;
    };
    // Re-checked on navigation so an 'unknown' from a blip resolves itself
    // without a reload.
  }, [user?.id, location.pathname]);

  const handleAccept = useCallback(async () => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Not authenticated');

    /* THE HEADER IS NOT OPTIONAL. Every World Hub `/api/club-arena/*` POST
       runs `checkIdempotency` before anything else, and that guard answers a
       request with no `X-Idempotency-Key` with a 400 - before auth, before the
       write. The first landing of this gate (#3547) sent no key, so every
       Accept & Continue on the site came back 400 "X-Idempotency-Key header
       required", the modal stayed up, and nobody could get past it. The key is
       what every other mutating call in `services/clubArenaApi.ts` sends; the
       fetch stays inline here (rather than going through that client) so the
       literal endpoint and the `response.ok` check below remain what
       `a-gate-that-gates-nothing.law.test.ts` pins. */
    const response = await fetch('/api/club-arena/accept-tos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': uuid(),
      },
      body: '{}',
    });

    /* THE STATE ONLY MOVES ON A CONFIRMED WRITE. An optimistic flip here would
       let the app through on a 500 and record nothing, which is the same
       false-negative the column has been carrying since it was created: an
       account that looks accepted to the client and is not accepted anywhere
       that counts. The modal reports and stays open. */
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || `Could not record acceptance (${response.status})`);
    }

    setState('accepted');
  }, []);

  /*
   * AUTHENTICATED BOOT HAS TWO SERVER-BACKED GATES, IN THIS ORDER.
   *
   * TOSGuard owns the outside of the router while CompleteProfileModal lives
   * inside AppLayout. Once this guard gives a definite `not_accepted`, the
   * layout (and therefore its profile-gate status marker) does not exist. The
   * production preflight used to wait for that impossible inner marker and
   * every authenticated post-deploy spec died in global setup without running
   * a single assertion.
   *
   * Publish this decision directly from its owner. It is hidden metadata, not
   * another source of truth: `state` is still populated only by
   * ProfileService.getTOSStatus and moves to accepted only after the public
   * acceptance endpoint confirms its durable write. Automation can now obey
   * the same outer-to-inner order as a player without guessing from a modal's
   * temporary absence while the status query is still in flight.
   */
  const statusMarker = (
    <span hidden data-tos-gate-status={isHydrating || !user?.id ? 'checking' : state} />
  );

  // Sign-in is AuthGuard's job, not this one's. A signed-out visitor has
  // nothing to accept and no row to write it to.
  if (isHydrating || !user?.id) {
    return (
      <>
        {statusMarker}
        {children}
      </>
    );
  }

  if (isAlwaysReachable(location.pathname)) {
    return (
      <>
        {statusMarker}
        {children}
      </>
    );
  }

  if (state === 'not_accepted') {
    /* No fallback UI: an empty frame for the ~100ms the chunk takes is
       preferable to a spinner that implies the app is loading normally, and
       to rendering the app underneath a gate that has already said no. */
    return (
      <>
        {statusMarker}
        <Suspense fallback={null}>
          <TOSAcceptanceModal onAccept={handleAccept} />
        </Suspense>
      </>
    );
  }

  // 'accepted', 'checking' and 'unknown' all render the app — see the header.
  return (
    <>
      {statusMarker}
      {children}
    </>
  );
}
