/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ANNOUNCEMENT BANNER - Important Club Messages
 * Displays pinned announcements from club admins
 * ═══════════════════════════════════════════════════════════════════════════════
 * USAGE:
 * - With clubId prop:  <ClubAnnouncementBanner clubId="abc123" />
 * - Auto-detect from URL: <ClubAnnouncementBanner /> (uses :clubId from route)
 *
 * #ClubArenaConsole (2026-09-14): A BANNER IS NOT A CARD. It is inked onto
 * the black glass - a lit word for its kind, the title in engraved silver,
 * the copy in Inter, one engraved rule under it - and never framed: no
 * border, no radius, no fill, no plate. The controls (previous / next /
 * dismiss) are lit words, not boxes. Every word a player reads, including the
 * announcement DATA a club typed, goes through titleCase() at the print site
 * (Dan 2026-09-14: "THE FIRST LETTER OF EVERY WORD MUST ALWAYS BE
 * CAPITALIZED").
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { masterBus } from '../../core/MasterBus';
import styles from './ClubAnnouncementBanner.module.css';
import '../console/SpadeConsole.css';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
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

    // Bus listener: refresh announcements when one is created/updated/deleted
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
                    profiles!club_announcements_profiles_fkey(${PLAYER_NAME_COLUMNS})
                `
        )
        .eq('club_id', resolvedId)
        .eq('is_active', true)
        .or(`expires_at.is.null,expires_at.gt.${now}`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) reportError(error, 'ClubAnnouncementBanner.loadAnnouncements');
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

  /* The kind is a lit word in the master's own ink, not an icon in a box:
     blue for news, gold for a warning, green for good news, red for urgent. */
  const getTypeWord = (type: string): string => {
    switch (type) {
      case 'warning':
        return 'Notice';
      case 'success':
        return 'Good News';
      case 'urgent':
        return 'Urgent';
      case 'info':
      default:
        return 'Announcement';
    }
  };

  const getTypeInk = (type: string): string => {
    switch (type) {
      case 'warning':
        return 'sc-ink--gold';
      case 'success':
        return 'sc-ink--green';
      case 'urgent':
        return 'sc-ink--red';
      case 'info':
      default:
        return 'sc-ink--blue';
    }
  };

  const getTypeClass = (type: string): string => (type === 'urgent' ? styles.urgent : '');

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
      className={`${styles.banner} ${getTypeClass(current.type)}`.trim()}
      role="status"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className={styles.content}>
        <span className={`${styles.kind} sc-label ${getTypeInk(current.type)}`}>
          {getTypeWord(current.type)}
        </span>
        <span className={`${styles.title} sc-ink--silver`}>{titleCase(current.title)}</span>
        <span className={styles.message}>{titleCase(current.message)}</span>
        {current.createdByName && (
          <span className={`${styles.author} sc-ink--muted`}>
            {titleCase(current.createdByName)}, {formatDate(current.createdAt)}
          </span>
        )}
      </div>

      <div className={styles.actions}>
        {visibleAnnouncements.length > 1 && (
          <div className={styles.pagination}>
            <button
              type="button"
              className={`${styles.word} sc-ink--blue`}
              onClick={() => setCurrentIndex((prev) => prev - 1)}
              aria-label="Previous Announcement"
            >
              Prev
            </button>
            <span className={`${styles.count} sc-ink--muted`}>
              {safeIndex + 1}/{visibleAnnouncements.length}
            </span>
            <button
              type="button"
              className={`${styles.word} sc-ink--blue`}
              onClick={() => setCurrentIndex((prev) => prev + 1)}
              aria-label="Next Announcement"
            >
              Next
            </button>
          </div>
        )}
        <button
          type="button"
          className={`${styles.word} ${styles.dismissBtn} sc-ink--muted`}
          onClick={() => dismiss(current.id)}
          aria-label="Dismiss Announcement"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
