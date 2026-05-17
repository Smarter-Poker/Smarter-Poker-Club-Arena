/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MESSAGES PAGE — Embedded World Hub Messenger
 * ═══════════════════════════════════════════════════════════════════════════════
 * Embeds the full premium multi-identity messenger from smarter.poker/hub/messenger
 * via a same-origin iframe. Improvements over legacy version:
 *
 *  1. PostMessage Bridge — unread badges stay in sync with CA GlobalHeader in
 *     real time (no polling). Messenger signals count changes up to parent.
 *  2. Compose deep link — CA can route to /messages?compose=USER_ID and the
 *     messenger auto-opens a new thread to that recipient.
 *  3. Skeleton loading — shimmer overlay while the iframe hydrates, fades out
 *     on load (eliminates black-flash blank screen).
 *  4. Bottom nav height pass-through — bottomPad query param tells the embedded
 *     messenger to offset its content so ClubBottomNav never occludes messages.
 *  5. Accessible iframe title.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useHeaderDataStore } from '../stores/useHeaderDataStore';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './MessagesPage.css';
import { reportError } from '../utils/errorReporter';

// Height of ClubBottomNav in px — tells the embedded messenger to pad its content
// so the input bar is never hidden behind the nav. Keep in sync with
// ClubBottomNav.module.css .bottomNav height.
const BOTTOM_NAV_HEIGHT_PX = 56;

export default function MessagesPage() {
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();
  const setUnreadMessages = useHeaderDataStore((s) => s.setUnreadMessages);
  const setMessengerPageActive = useHeaderDataStore((s) => s.setMessengerPageActive);

  useEffect(() => {
    document.title = 'Messages | Smarter Poker';
    setMessengerPageActive(true);
    return () => setMessengerPageActive(false);
  }, [setMessengerPageActive]);

  const { clubId: routeClubId, conversationId } = useParams<{
    clubId?: string;
    conversationId?: string;
  }>();
  const clubId = routeClubId || searchParams.get('club') || undefined;

  // Compose deep-link: if ?compose=USER_ID is present, pass it into the iframe
  // messenger.js already handles router.query.uid / router.query.compose (line 2721)
  const composeUserId = searchParams.get('compose') || searchParams.get('uid') || undefined;

  // Conversation deep-link from path params or query param:
  const activeConversationId = conversationId || searchParams.get('conversation') || undefined;

  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Fetch actual user role for this club so ClubBottomNav shows correct tabs
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', clubId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!cancelled && data?.role) {
          setUserRole(data.role as typeof userRole);
        }
      } catch (e) {
        reportError(e, 'MessagesPage.async');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  // ── PostMessage Bridge: receive unread count + identity signals from iframe ──
  // The embedded messenger emits MESSENGER_UNREAD_COUNT whenever totalUnreadSum
  // changes. We pipe that directly into the Zustand header store so the CA
  // GlobalHeader badge stays in real-time sync without any Supabase polling.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security: only accept messages from same origin
      if (event.origin !== window.location.origin) return;
      const { type, source } = event.data || {};
      if (source !== 'smarter-poker-messenger') return;

      if (type === 'MESSENGER_UNREAD_COUNT' && typeof event.data.count === 'number') {
        setUnreadMessages(event.data.count);
      }
      // Future: handle MESSENGER_IDENTITY_CHANGED to reflect active persona in CA header
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setUnreadMessages]);

  // Build iframe URL — passes all routing context into the embedded messenger
  const messengerParams = new URLSearchParams({
    hideHeader: 'true',
    ...(clubId && { clubId }),
    ...(composeUserId && { uid: composeUserId }),
    ...(activeConversationId && { conversation: activeConversationId }),
    ...(clubId && { bottomPad: String(BOTTOM_NAV_HEIGHT_PX) }),
  });
  const messengerUrl = `/hub/messenger?${messengerParams.toString()}`;

  const [iframeError, setIframeError] = useState(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start a 12-second timeout when the iframe URL is set.
  // If onLoad hasn't fired by then, show the error fallback (e.g. offline / server error).
  useEffect(() => {
    setIframeError(false);
    setIframeLoaded(false);
    loadTimeoutRef.current = setTimeout(() => {
      setIframeError((prev) => (!iframeLoaded && !prev ? true : prev));
    }, 12000);
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messengerUrl]);

  const handleRetry = () => {
    setIframeError(false);
    setIframeLoaded(false);
    // Force a reload by briefly clearing the iframe src — done via key change
    setRetryKey((k) => k + 1);
  };
  const [retryKey, setRetryKey] = useState(0);

  return (
    <div className="messages-page">
      {/* Error fallback — shown if iframe never loads (offline / server down) */}
      {iframeError ? (
        <div className="messages-error" role="alert">
          <span className="messages-error-icon">⚠</span>
          <p className="messages-error-title">Messenger Unavailable</p>
          <p className="messages-error-hint">Check your connection and try again.</p>
          <button className="messages-error-retry" onClick={handleRetry}>
            Retry
          </button>
        </div>
      ) : (
        <>
          {/* Skeleton shimmer — shown while iframe hydrates, fades out on load */}
          {!iframeLoaded && (
            <div className="messages-skeleton" aria-hidden="true">
              <div className="skeleton-header" />
              {[...Array(6)].map((_, i) => (
                <div key={i} className="skeleton-row">
                  <div className="skeleton-avatar" />
                  <div className="skeleton-lines">
                    <div className="skeleton-line skeleton-line--name" />
                    <div className="skeleton-line skeleton-line--preview" />
                  </div>
                </div>
              ))}
            </div>
          )}

          <iframe
            key={retryKey}
            ref={iframeRef}
            src={messengerUrl}
            title={clubId ? 'Club Messenger' : 'Smarter.Poker Messenger'}
            allow="camera; microphone; display-capture; autoplay"
            loading="lazy"
            onLoad={() => {
              setIframeLoaded(true);
              if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current);
            }}
            style={{ opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.25s ease' }}
          />
        </>
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
