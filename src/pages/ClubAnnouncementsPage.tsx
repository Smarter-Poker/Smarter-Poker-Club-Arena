/**
 *  CLUB ANNOUNCEMENTS PAGE — Live Updates
 */

import { useState, useEffect, useRef } from 'react';
import type { ClubRole } from '../types/clubRoles';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { sanitizeInput } from '../utils/sanitizeInput';
import ConfirmModal from '../components/common/ConfirmModal';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { formatDate } from '../utils/format';
import './ClubAnnouncementsPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { reportError } from '../utils/errorReporter';

const announcementAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

/* Whole-word plural, Title Case, for the painted pill slot. */
const postsPill = (n: number) => (n === 1 ? '1 Post' : `${n} Posts`);

interface Announcement {
  id: string;
  title: string;
  content: string;
  created_at: string;
  author_name: string;
  is_pinned: boolean;
}

export default function ClubAnnouncementsPage() {
  const navigate = useNavigate();
  const { clubId } = useParams();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(() => loadAnnouncements());

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [clubName, setClubName] = useState('');
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [showComposer, setShowComposer] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setIsAdmin(false);
    setClubName('');
    setUserRole('player');
    setPosting(false);
    setShowComposer(false);
    setNewTitle('');
    setNewContent('');
    setDeleteTarget(null);
    setLoadError(false);
    loadingRef.current = false;
  }, [clubId]);

  useEffect(() => {
    if (clubId) {
      let isMounted = true;
      loadAnnouncements(() => isMounted);

      const channelKey = `announcements-${clubId}`;

      const setupRealtime = async () => {
        const resolvedId = await resolveClubUUID(clubId);
        if (!isMounted) return;

        const channel = masterBus.getOrCreateChannel(channelKey);
        channel
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'club_announcements',
              filter: `club_id=eq.${resolvedId}`,
            },
            (payload) => {
              if (!isMounted) return;
              if (payload.eventType === 'INSERT') {
                toast.info(' New announcement posted!');
              } else if (payload.eventType === 'UPDATE') {
                toast.info(' Announcement updated!');
              } else if (payload.eventType === 'DELETE') {
                toast.info(' Announcement removed!');
              }
              loadAnnouncements(() => isMounted);
            }
          )
          .subscribe((status: string, err?: Error) => {
            if (status === 'CHANNEL_ERROR') {
              if (err)
                reportError(err?.message || err, 'ClubAnnouncementsPage._Realtime_channel_error');
            }
            if (status === 'TIMED_OUT') {
              console.warn('[ClubAnnouncementsPage] Realtime channel timed out');
            }
          });
      };

      setupRealtime().catch((e) =>
        console.warn('[ClubAnnouncementsPage] Realtime setup failed:', e)
      );

      return () => {
        isMounted = false;
        masterBus.removeRegisteredChannel(channelKey);
      };
    }
  }, [clubId]);

  // ── Bus Listeners: cross-page event reactivity ──
  useEffect(() => {
    const unsubJoined = masterBus.subscribeDebounced(
      'CLUB_JOINED',
      () => {
        loadAnnouncements();
      },
      500
    );
    // Cross-tab sync: reload when announcements are changed from another component
    const unsubAnnouncement = masterBus.subscribeDebounced(
      'ANNOUNCEMENT_CHANGED',
      (event) => {
        if (event.payload?.clubId === clubId) {
          loadAnnouncements();
        }
      },
      500
    );
    return () => {
      unsubJoined();
      unsubAnnouncement();
    };
  }, [clubId]);

  const loadAnnouncements = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(false);
    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const swrKey = `ann_cache_${resolvedId}`;

      // SWR: show cached announcements instantly
      try {
        const cached = sessionStorage.getItem(swrKey);
        if (cached) {
          const c = JSON.parse(cached);
          if (Array.isArray(c)) {
            setAnnouncements(c);
            setLoading(false);
          }
        }
      } catch (e) {
        reportError(e, 'ClubAnnouncementsPage.loadAnnouncements');
        /* corrupt cache */
      }

      const { data, error } = await supabase
        .from('club_announcements')
        .select('id, title, content, created_at, is_pinned, author_id')
        .eq('club_id', resolvedId)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(200);

      if (getIsMounted && !getIsMounted()) return;
      if (!error && data) {
        // Batch-fetch author profiles separately (safe, no FK hint)
        const authorIds = [...new Set(data.map((a: any) => a.author_id).filter(Boolean))];
        const authorMap: Record<string, string> = {};
        if (authorIds.length > 0) {
          try {
            const { data: profs } = await supabase
              .from('profiles')
              .select('id, username')
              .in('id', authorIds);
            if (profs) for (const p of profs) authorMap[p.id] = p.username || 'Admin';
          } catch (e) {
            reportError(e, 'ClubAnnouncementsPage.Set');
            /* non-critical */
          }
        }
        const mappedAnnouncements = data.map((a: any) => ({
          id: a.id,
          title: a.title,
          content: a.content,
          created_at: a.created_at,
          author_name: authorMap[a.author_id] || 'Admin',
          is_pinned: a.is_pinned,
        }));
        setAnnouncements(mappedAnnouncements);

        // SWR: cache successful fetch
        try {
          sessionStorage.setItem(swrKey, JSON.stringify(mappedAnnouncements.slice(0, 20)));
        } catch {
          /* storage full */
        }
      }

      /* The club's name for the header well. Non-fatal: a page with no name
         still shows every announcement. */
      try {
        const { data: club, error: clubErr } = await supabase
          .from('clubs')
          .select('name')
          .eq('id', resolvedId)
          .maybeSingle();
        if (getIsMounted && !getIsMounted()) return;
        if (clubErr) reportError(clubErr, 'ClubAnnouncementsPage.club_name');
        if (club?.name) setClubName(club.name);
      } catch (e) {
        reportError(e, 'ClubAnnouncementsPage.club_name');
      }

      if (user?.id) {
        /* The error is read: a transient failure used to be identical to "you are
         not staff here", quietly removing the composer and the pin and delete
         controls with nothing said. It still fails closed - that is right - but
         it says so now. */
        const { data: membership, error: membershipErr } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();

        if (getIsMounted && !getIsMounted()) return;
        const memberRole = membership?.role || '';
        if (membershipErr) reportError(membershipErr, 'ClubAnnouncementsPage.role_lookup_failed');
        setIsAdmin(['owner', 'co_owner', 'admin'].includes(memberRole));
        if (['owner', 'co_owner', 'admin', 'agent'].includes(memberRole)) {
          setUserRole(memberRole as 'owner' | 'admin' | 'agent');
        }
      }
    } catch (error) {
      reportError(error, 'ClubAnnouncementsPage.Failed_to_load_announcements');
      setLoadError(true);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load announcements');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const handlePost = async () => {
    if (!newTitle.trim() || !newContent.trim() || !clubId || !user?.id) return;

    setPosting(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { error } = await supabase.from('club_announcements').insert({
        club_id: resolvedId,
        author_id: user.id,
        title: sanitizeInput(newTitle.trim()),
        content: sanitizeInput(newContent.trim()),
        is_pinned: false,
      });

      if (!error && clubId) {
        setNewTitle('');
        setNewContent('');
        setShowComposer(false);
        loadAnnouncements();
        masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'created' });
        toast.success('Announcement posted!');
      } else if (error) {
        toast.error('Failed to post announcement');
      }
    } catch (error) {
      reportError(error, 'ClubAnnouncementsPage.Failed_to_post_announcement');
      // 2026-08-28: this catch was error reporting-only. A thrown failure (network,
      // resolveClubUUID) left the composer open with no success and no error
      // — the user could not tell whether the post landed. The in-band error
      // branch above already toasts; a thrown one must too.
      toast.error('Failed to post announcement');
    }
    setPosting(false);
  };

  const handleTogglePin = async (id: string, currentlyPinned: boolean) => {
    try {
      /* `.select('id')`: an UPDATE that RLS refuses matches zero rows and
         returns 204 with no error, so this used to reload the list and toast
         "Announcement pinned" over a row whose pin had not moved - the reload
         then repainted the OLD state underneath the success message. */
      const { data: pinned, error } = await supabase
        .from('club_announcements')
        .update({ is_pinned: !currentlyPinned })
        .eq('id', id)
        .select('id');

      if (error) {
        toast.error('Failed to update pin status');
      } else if (!pinned || pinned.length === 0) {
        toast.error('That Pin Did Not Change. You May Not Have Permission To Change It.');
        loadAnnouncements();
      } else {
        loadAnnouncements();
        toast.success(currentlyPinned ? 'Announcement unpinned' : 'Announcement pinned');
      }
    } catch (err) {
      reportError(err, 'ClubAnnouncementsPage.Failed_to_toggle_pin');
      toast.error('Failed to update pin status');
    }
  };

  // Confirm modal state for deleting announcements
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    setDeleteTarget(id);
  };

  const executeDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget;
    setDeleteTarget(null);
    try {
      // SECURITY: Scope delete to club to prevent cross-club deletion
      let delQuery = supabase.from('club_announcements').delete().eq('id', id);
      if (clubId) {
        const resolvedId = await resolveClubUUID(clubId);
        delQuery = delQuery.eq('club_id', resolvedId);
      }
      /* Same reason as the pin above, and worse here: the line that removed the
         announcement from local state ran on a refusal too, so the notice
         vanished from the operator's screen and stayed live for every player. */
      const { data: deleted, error } = await delQuery.select('id');

      if (error) {
        toast.error('Failed to delete announcement');
      } else if (!deleted || deleted.length === 0) {
        toast.error('That Announcement Was Not Deleted. It May Belong To Another Club.');
        loadAnnouncements();
      } else {
        setAnnouncements((prev) => prev.filter((a) => a.id !== id));
        toast.success('Announcement deleted');
        if (clubId) masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'deleted' });
      }
    } catch (err) {
      reportError(err, 'ClubAnnouncementsPage.Failed_to_delete_announcement');
      toast.error('Failed to delete announcement');
    }
  };

  /* THE CONSOLE (2026-09-08). This was a stack of rounded navy cards with a
     yellow pinned stripe, an amber PINNED chip, a cyan button bar and a row of
     outlined Pin / Delete buttons under every post. It is now the spade
     console, like Club Rules beside it: the club's name is the eyebrow,
     ANNOUNCEMENTS is engraved in the header well, the count sits in the
     painted pill slot, and every post prints on the glass between the rails
     with an engraved rule between them - PINNED in gold, the title in silver,
     the copy in the console's own type, who and when in muted ink. Staff get
     the two plates painted into the foot (REFRESH / NEW POST, or CANCEL / POST
     while writing) and a lit word on each post for Pin and Delete. Nothing is
     drawn; nothing is stuck on. Every handler above is untouched. */
  const canPost = !posting && !!newTitle.trim() && !!newContent.trim();
  const staffPlates =
    isAdmin && !loading && !loadError
      ? showComposer
        ? {
            secondary: {
              label: 'Cancel',
              onClick: () => setShowComposer(false),
              disabled: posting,
            },
            primary: {
              label: posting ? 'Posting' : 'Post',
              ink: 'white' as const,
              onClick: () => void handlePost(),
              disabled: !canPost,
            },
          }
        : {
            secondary: {
              label: 'Refresh',
              onClick: () => void loadAnnouncements(),
            },
            primary: {
              label: 'New Post',
              ink: 'white' as const,
              onClick: () => setShowComposer(true),
            },
          }
      : undefined;

  return (
    <StandardContentLayout className="announcements-page">
      <SpadeConsole
        className="announcements-console"
        aria-busy={loading || posting || undefined}
        eyebrow={clubName || 'Club'}
        title="Announcements"
        pill={
          loadError
            ? 'Offline'
            : loading
              ? undefined
              : announcements.length === 0
                ? 'Empty'
                : postsPill(announcements.length)
        }
        pillInk={loadError ? 'red' : announcements.length === 0 ? 'muted' : 'blue'}
        plates={staffPlates}
        foot={staffPlates ? 'plates' : 'foot'}
      >
        {loadError && !loading ? (
          <div className="ann-empty">
            <span className="sc-label sc-ink--red">Could Not Load</span>
            <p className="sc-copy sc-copy--center">Failed To Load Announcements.</p>
            <button
              type="button"
              className="ann-word sc-ink--blue"
              onClick={() => loadAnnouncements()}
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="loading-state">
            <PageSkeleton variant="list" />
          </div>
        ) : (
          <>
            {showComposer && (
              <div className="ann-composer">
                <input
                  type="text"
                  placeholder="Announcement Title"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="ann-input"
                  maxLength={100}
                  aria-label="Announcement Title"
                />
                <textarea
                  placeholder="Write Your Announcement"
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  rows={5}
                  className="ann-textarea"
                  maxLength={2000}
                  aria-label="Announcement"
                />
              </div>
            )}

            {announcements.length === 0 ? (
              <div className="ann-empty">
                <span className="sc-label sc-ink--blue">No Announcements Yet</span>
                <p className="sc-copy sc-copy--center">
                  {isAdmin
                    ? 'Post The First One For Your Members.'
                    : 'The Club Has Not Posted Anything Yet.'}
                </p>
              </div>
            ) : (
              <ol className="ann-list">
                {announcements.map((announcement, idx) => (
                  <li
                    key={announcement.id}
                    style={announcementAnimationStyle(idx)}
                    className={`ann-post ${announcement.is_pinned ? 'ann-post--pinned' : ''}`.trim()}
                  >
                    {announcement.is_pinned && (
                      <span className="sc-label sc-ink--gold ann-post__pin">Pinned</span>
                    )}
                    <h3 className="ann-post__title sc-ink--silver">{announcement.title}</h3>
                    <p className="sc-copy ann-post__content">{announcement.content}</p>
                    <div className="ann-post__meta sc-ink--muted">
                      <span>By {announcement.author_name}</span>
                      <span>{formatDate(announcement.created_at)}</span>
                    </div>
                    {isAdmin && (
                      <div className="ann-post__actions">
                        <button
                          type="button"
                          className="ann-word sc-ink--blue"
                          onClick={() => handleTogglePin(announcement.id, announcement.is_pinned)}
                        >
                          {announcement.is_pinned ? 'Unpin' : 'Pin'}
                        </button>
                        <button
                          type="button"
                          className="ann-word sc-ink--red"
                          onClick={() => handleDelete(announcement.id)}
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </>
        )}
      </SpadeConsole>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        title="Delete Announcement"
        message="Are you sure you want to delete this announcement? This cannot be undone."
        variant="danger"
        confirmText="Delete"
        onConfirm={executeDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </StandardContentLayout>
  );
}
