/**
 *  CLUB ANNOUNCEMENTS PAGE — Live Updates
 */

import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import ClubBottomNav from '../components/club/ClubBottomNav';
import { useToast } from '../components/common/Toast';
import { sanitizeInput } from '../utils/sanitizeInput';
import ConfirmModal from '../components/common/ConfirmModal';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubUUID } from '../utils/clubIdResolver';
import './ClubAnnouncementsPage.css';
import PageSkeleton from '../components/common/PageSkeleton';

const announcementAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(8px)',
  animation: `fadeInUp 0.5s ease-out ${index * 60}ms forwards`,
});

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
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [showComposer, setShowComposer] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [posting, setPosting] = useState(false);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');

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
          .subscribe();
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
    return () => {
      unsubJoined();
    };
  }, []);

  const loadAnnouncements = async (getIsMounted?: () => boolean) => {
    if (!clubId) return;
    if (!getIsMounted || getIsMounted()) setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);

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
          } catch {
            /* non-critical */
          }
        }
        setAnnouncements(
          data.map((a: any) => ({
            id: a.id,
            title: a.title,
            content: a.content,
            created_at: a.created_at,
            author_name: authorMap[a.author_id] || 'Admin',
            is_pinned: a.is_pinned,
          }))
        );
      }

      if (user?.id) {
        const { data: membership } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user.id)
          .maybeSingle();

        if (getIsMounted && !getIsMounted()) return;
        setIsAdmin(['owner', 'admin'].includes(membership?.role || ''));
      }
    } catch (error) {
      console.error('Failed to load announcements:', error);
      if (!getIsMounted || getIsMounted()) toast.error('Failed to load announcements');
    }
    if (!getIsMounted || getIsMounted()) setLoading(false);
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
      console.error('Failed to post announcement:', error);
    }
    setPosting(false);
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const handleTogglePin = async (id: string, currentlyPinned: boolean) => {
    try {
      const { error } = await supabase
        .from('club_announcements')
        .update({ is_pinned: !currentlyPinned })
        .eq('id', id);

      if (!error) {
        loadAnnouncements();
        toast.success(currentlyPinned ? 'Announcement unpinned' : 'Announcement pinned');
      } else {
        toast.error('Failed to update pin status');
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
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
      if (clubId) delQuery = delQuery.eq('club_id', clubId);
      const { error } = await delQuery;

      if (!error) {
        setAnnouncements((prev) => prev.filter((a) => a.id !== id));
        toast.success('Announcement deleted');
        if (clubId) masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'deleted' });
      } else {
        toast.error('Failed to delete announcement');
      }
    } catch (err) {
      console.error('Failed to delete announcement:', err);
      toast.error('Failed to delete announcement');
    }
  };

  return (
    <div className="announcements-page">
      {isAdmin && !showComposer && (
        <div className="admin-bar">
          <button className="btn btn-primary" onClick={() => setShowComposer(true)}>
            + New Announcement
          </button>
        </div>
      )}

      {showComposer && (
        <div className="composer">
          <input
            type="text"
            placeholder="Announcement Title..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            className="composer-title"
          />
          <textarea
            placeholder="Write your announcement..."
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={4}
            className="composer-content"
          />
          <div className="composer-actions">
            <button className="btn btn-ghost" onClick={() => setShowComposer(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handlePost}
              disabled={posting || !newTitle.trim() || !newContent.trim()}
            >
              {posting ? 'Posting...' : 'Post'}
            </button>
          </div>
        </div>
      )}

      <div className="announcements-list">
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="list" />
          </div>
        ) : announcements.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">◈</span>
            <p>No announcements yet</p>
          </div>
        ) : (
          announcements.map((announcement, idx) => (
            <div
              key={announcement.id}
              style={announcementAnimationStyle(idx)}
              className={`announcement-card ${announcement.is_pinned ? 'pinned' : ''}`}
            >
              {announcement.is_pinned && <span className="pin-badge">Pinned</span>}
              <h3 className="announcement-title">{announcement.title}</h3>
              <p className="announcement-content">{announcement.content}</p>
              <div className="announcement-meta">
                <span className="announcement-author">By {announcement.author_name}</span>
                <span className="announcement-date">{formatDate(announcement.created_at)}</span>
              </div>
              {isAdmin && (
                <div className="announcement-admin-actions">
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={() => handleTogglePin(announcement.id, announcement.is_pinned)}
                  >
                    {announcement.is_pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleDelete(announcement.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} />}

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
    </div>
  );
}
