/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ANNOUNCEMENT BANNER — Important Club Messages
 * Displays pinned announcements from club admins
 * ═══════════════════════════════════════════════════════════════════════════════
 * USAGE:
 * - With clubId prop:  <ClubAnnouncementBanner clubId="abc123" />
 * - Auto-detect from URL: <ClubAnnouncementBanner /> (uses :clubId from route)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { masterBus } from '../../core/MasterBus';
import styles from './ClubAnnouncementBanner.module.css';
import { reportError } from '../../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../../utils/playerDisplayName';

interface Announcement {
  id: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'success' | 'urgent';
  createdAt: string;
  expiresAt?: string;
  createdBy: string;
  createdByName?: string;
}

interface ClubAnnouncementBannerProps {
  clubId?: string; // Optional - will auto-detect from route if not provided
  onDismiss?: (announcementId: string) => void;
}

export default function ClubAnnouncementBanner({
  clubId: propClubId,
  onDismiss,
}: ClubAnnouncementBannerProps) {
  // Auto-detect clubId from route params if not provided
  const { clubId: routeClubId } = useParams<{ clubId?: string }>();
  const clubId = propClubId || routeClubId;

  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
    const _mountTimer = setTimeout(() => setMounted(true), 50);
    return () => clearTimeout(_mountTimer);
  }, []);

  useEffect(() => {
    if (!clubId) {
      setLoading(false);
      return;
    }
    loadAnnouncements();
    // Load dismissed from localStorage
    const stored = localStorage.getItem(`dismissed_announcements_${clubId}`);
    if (stored) {
      try {
        setDismissed(new Set(JSON.parse(stored)));
      } catch (err) {
        reportError(err, 'ClubAnnouncementBanner.Error');
        localStorage.removeItem(`dismissed_announcements_${clubId}`);
      }
    }

    // 🔴 Bus Listener: refresh announcements when one is created/updated/deleted
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
      const now = new Date().toISOString();
      if (!clubId) return;
      const resolvedId = await resolveClubUUID(clubId!);
      const { data, error } = await supabase
        .from('club_announcements')
        .select(
          `
                    id,
                    title,
                    message,
                    type,
                    created_at,
                    expires_at,
                    created_by,
                    profiles:profiles!club_announcements_profiles_fkey(${PLAYER_NAME_COLUMNS})
                `
        )
        .eq('club_id', resolvedId)
        .eq('is_active', true)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (!error && data) {
        if (!isMounted.current) return;
        const mapped: Announcement[] = data.map((a: any) => ({
          id: a.id,
          title: a.title,
          message: a.message,
          type: a.type || 'info',
          createdAt: a.created_at,
          expiresAt: a.expires_at,
          createdBy: a.created_by,
          createdByName: playerDisplayName(a.profiles),
        }));
        setAnnouncements(mapped);
      }
    } catch (error) {
      reportError(error, 'ClubAnnouncementBanner.Failed_to_load_announcements');
    }
    if (isMounted.current) setLoading(false);
  };

  const dismiss = (id: string) => {
    const newDismissed = new Set(dismissed).add(id);
    setDismissed(newDismissed);
    localStorage.setItem(`dismissed_announcements_${clubId}`, JSON.stringify([...newDismissed]));
    onDismiss?.(id);
  };

  const getTypeIcon = (type: string): string => {
    switch (type) {
      case 'info':
        return 'i';
      case 'warning':
        return '!';
      case 'success':
        return '✓';
      case 'urgent':
        return '!!';
      default:
        return 'i';
    }
  };

  const getTypeClass = (type: string): string => {
    switch (type) {
      case 'info':
        return styles.info;
      case 'warning':
        return styles.warning;
      case 'success':
        return styles.success;
      case 'urgent':
        return styles.urgent;
      default:
        return '';
    }
  };

  const formatDate = (dateStr: string): string => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  };

  const visibleAnnouncements = announcements.filter((a) => !dismissed.has(a.id));

  if (loading || visibleAnnouncements.length === 0) {
    return null;
  }

  // Safe modulo to avoid negative index (JS % can return negative)
  const safeIndex =
    ((currentIndex % visibleAnnouncements.length) + visibleAnnouncements.length) %
    visibleAnnouncements.length;
  const current = visibleAnnouncements[safeIndex];

  return (
    <div
      className={`${styles.banner} ${getTypeClass(current.type)}`}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className={styles.content}>
        <span className={styles.icon}>{getTypeIcon(current.type)}</span>
        <div className={styles.text}>
          <span className={styles.title}>{current.title}</span>
          <span className={styles.message}>{current.message}</span>
        </div>
      </div>

      <div className={styles.meta}>
        {current.createdByName && (
          <span className={styles.author}>
            - {current.createdByName}, {formatDate(current.createdAt)}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        {visibleAnnouncements.length > 1 && (
          <div className={styles.pagination}>
            <button
              onClick={() => setCurrentIndex((prev) => prev - 1)}
              aria-label="Previous Announcement"
            >
              ‹
            </button>
            <span>
              {safeIndex + 1}/{visibleAnnouncements.length}
            </span>
            <button
              onClick={() => setCurrentIndex((prev) => prev + 1)}
              aria-label="Next Announcement"
            >
              ›
            </button>
          </div>
        )}
        <button
          className={styles.dismissBtn}
          onClick={() => dismiss(current.id)}
          aria-label="Dismiss Announcement"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
