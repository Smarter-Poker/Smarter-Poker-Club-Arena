/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB MESSAGES PAGE — Embedded World Hub Messenger (Club-Scoped)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Embeds the premium multi-identity messenger with the club identity pre-selected.
 * Shares the same PostMessage bridge, skeleton loading, and bottomPad support
 * as the general MessagesPage — ensuring a consistent UX across both entry points.
 */

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuthUser } from '../hooks/useAuthUser';
import { useHeaderDataStore } from '../stores/useHeaderDataStore';
import ClubBottomNav from '../components/club/ClubBottomNav';
import './ClubMessagesPage.css';
import { reportError } from '../utils/errorReporter';

const BOTTOM_NAV_HEIGHT_PX = 56;

export default function ClubMessagesPage() {
  const { user } = useAuthUser();
  const setUnreadMessages = useHeaderDataStore((s) => s.setUnreadMessages);
  const setMessengerPageActive = useHeaderDataStore((s) => s.setMessengerPageActive);

  useEffect(() => {
    setMessengerPageActive(true);
    return () => setMessengerPageActive(false);
  }, [setMessengerPageActive]);

  const { clubId: urlClubId } = useParams<{ clubId?: string }>();
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');
  const [clubId, setClubId] = useState<string | undefined>(urlClubId);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole('member');
    setClubId(urlClubId);
    // Reset skeleton so it shows again for the new club's load
    setIframeLoaded(false);
  }, [urlClubId]);

  // Hydrate userRole from club_members so BottomNav shows correct tabs
  useEffect(() => {
    if (!clubId || !user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const { resolveClubUUID } = await import('../utils/clubIdResolver');
        const resolvedId = await resolveClubUUID(clubId);
        if (cancelled) return;
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();
        if (!cancelled && data?.role) {
          setUserRole(data.role as 'owner' | 'admin' | 'agent' | 'member');
        }
      } catch (e) {
        reportError(e, 'ClubMessagesPage.async');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, user?.id]);

  // ── PostMessage Bridge: receive unread count from embedded messenger ──
  // Keeps CA GlobalHeader badge in real-time sync with the iframe's live count.
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const { type, source } = event.data || {};
      if (source !== 'smarter-poker-messenger') return;
      if (type === 'MESSENGER_UNREAD_COUNT' && typeof event.data.count === 'number') {
        setUnreadMessages(event.data.count);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [setUnreadMessages]);

  // Build iframe URL — force club identity + pass bottom nav height
  const messengerParams = new URLSearchParams({
    hideHeader: 'true',
    ...(clubId && { clubId }),
    ...(clubId && { bottomPad: String(BOTTOM_NAV_HEIGHT_PX) }),
  });
  const messengerUrl = clubId
    ? `/hub/messenger?${messengerParams.toString()}`
    : '/hub/messenger?hideHeader=true';

  return (
    <div className="club-messages-page">
      {/* Skeleton shimmer — fades out when iframe is ready */}
      {!iframeLoaded && (
        <div className="club-messages-skeleton" aria-hidden="true">
          <div className="skeleton-header" />
          {[...Array(5)].map((_, i) => (
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
        ref={iframeRef}
        src={messengerUrl}
        title={clubId ? 'Club Messenger' : 'Smarter.Poker Messenger'}
        allow="camera; microphone; display-capture; autoplay"
        loading="lazy"
        onLoad={() => setIframeLoaded(true)}
        style={{ opacity: iframeLoaded ? 1 : 0, transition: 'opacity 0.25s ease' }}
      />

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}
    </div>
  );
}
