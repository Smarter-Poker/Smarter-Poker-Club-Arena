/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ANNOUNCEMENTS — Display Club News
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { supabase } from '../../lib/supabase';
import { useToast } from '../common/Toast';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { masterBus } from '../../core/MasterBus';
import './ClubAnnouncementsList.css';
import { reportError } from '../../utils/errorReporter';

interface ClubAnnouncementsListProps {
  clubId: string;
  isAdmin?: boolean;
  limit?: number;
}

interface Announcement {
  id: string;
  title: string;
  content: string;
  authorName: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  isPinned: boolean;
  createdAt: Date;
  expiresAt?: Date;
}

const PRIORITY_COLORS: Record<string, string> = {
  low: '#6b7280',
  normal: '#3b82f6',
  high: '#f59e0b',
  urgent: '#ef4444',
};

export function ClubAnnouncementsList({ clubId, isAdmin, limit = 10 }: ClubAnnouncementsListProps) {
  const toast = useToast();
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const isMounted = useIsMounted();
  const [loading, setLoading] = useState(true);
  /** "We could not ask" is not "there is nothing to say". */
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    loadAnnouncements();

    const unsub = masterBus.subscribeDebounced(
      'ANNOUNCEMENT_CHANGED',
      () => {
        loadAnnouncements();
      },
      500
    );

    return () => {
      unsub();
    };
  }, [clubId]);

  const loadAnnouncements = async () => {
    setLoading(true);
    try {
      const resolvedId = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_announcements')
        .select('*, author:profiles!author_id(username)')
        .eq('club_id', resolvedId)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        // `if (!error && data)` left the list at [] and cleared the spinner, so
        // a refused read rendered "No Announcements" - a statement about the
        // club, made without an answer from the database.
        reportError(error, 'ClubAnnouncementsList.loadAnnouncements');
        setLoadFailed(true);
        return;
      }
      setLoadFailed(false);
      {
        setAnnouncements(
          data.map((a) => {
            const author = Array.isArray(a.author) ? a.author[0] : a.author;
            return {
              id: a.id,
              title: a.title,
              content: a.content,
              authorName: author?.username || 'Admin',
              priority: a.priority || 'normal',
              isPinned: a.is_pinned || false,
              createdAt: new Date(a.created_at),
              expiresAt: a.expires_at ? new Date(a.expires_at) : undefined,
            };
          })
        );
      }
    } catch (error) {
      reportError(error, 'ClubAnnouncementsList.loadAnnouncements');
      setLoadFailed(true);
      toast.error('Failed To Load Announcements');
    }
    if (isMounted.current) setLoading(false);
  };

  const deleteAnnouncement = async (id: string) => {
    if (!isAdmin) return;

    try {
      // SECURITY: Scope to club to prevent cross-club deletion
      let delQuery = supabase.from('club_announcements').delete().eq('id', id);
      if (clubId) delQuery = delQuery.eq('club_id', clubId);
      const { error } = await delQuery;
      if (error) throw error;
      toast.success('Announcement deleted');
      loadAnnouncements();
    } catch (err) {
      reportError(err, 'ClubAnnouncementsList.Error');
      toast.error('Failed to delete');
    }
  };

  const formatDate = (date: Date) => {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));

    if (hours < 1) return 'Just now';
    if (hours < 24) return `${hours}h ago`;
    if (hours < 48) return 'Yesterday';
    return date.toLocaleDateString();
  };

  if (loading) {
    return <div className="announcements-list loading">Loading...</div>;
  }

  return (
    <div className="announcements-list">
      <div className="announcements-list__header">
        <h3> Announcements</h3>
      </div>

      {loadFailed && announcements.length === 0 ? (
        <div className="empty-state">Announcements Could Not Be Loaded. Try Again.</div>
      ) : announcements.length === 0 ? (
        <div className="empty-state">No Announcements</div>
      ) : (
        <div className="announcements">
          {announcements.map((ann, i) => (
            <div
              key={ann.id}
              className={`announcement ${ann.isPinned ? 'pinned' : ''}`}
              style={{
                borderLeftColor: PRIORITY_COLORS[ann.priority],
                opacity: i < 15 ? 1 : 0.8,
                transform: 'translateY(0)',
                transition: `all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) ${i * 60}ms`,
              }}
            >
              <div className="announcement__header">
                {ann.isPinned && <span className="pin"></span>}
                <span className="title">{ann.title}</span>
                {isAdmin && (
                  <button className="delete-btn" onClick={() => deleteAnnouncement(ann.id)}>
                    ×
                  </button>
                )}
              </div>
              <p className="content">{ann.content}</p>
              <div className="meta">
                <span className="author">By {ann.authorName}</span>
                <span className="time">{formatDate(ann.createdAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ClubAnnouncementsList;
