/**
 * ♠ CLUB ARENA — Club Announcements Banner
 * Scrolling announcements for clubs
 */

import React, { useState, useEffect, useRef } from 'react';
import './AnnouncementBanner.css';

interface Announcement {
  id: string;
  type: 'info' | 'warning' | 'promo' | 'event';
  title: string;
  message: string;
  link?: string;
  expiresAt?: string;
}

interface AnnouncementBannerProps {
  announcements: Announcement[];
  onDismiss?: (id: string) => void;
  onClick?: (announcement: Announcement) => void;
}

export const AnnouncementBanner: React.FC<AnnouncementBannerProps> = ({
  announcements,
  onDismiss,
  onClick,
}) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const validAnnouncements = announcements.filter((a) => {
    if (!a.expiresAt) return true;
    return new Date(a.expiresAt) > new Date();
  });

  useEffect(() => {
    if (validAnnouncements.length <= 1 || isPaused) return;

    intervalRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % validAnnouncements.length);
    }, 5000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [validAnnouncements.length, isPaused]);

  if (validAnnouncements.length === 0) return null;

  const current = validAnnouncements[currentIndex];

  const getTypeIcon = (type: Announcement['type']) => {
    switch (type) {
      case 'info':
        return 'ℹ';
      case 'warning':
        return '⚠';
      case 'promo':
        return '◈';
      case 'event':
        return '★';
      default:
        return '◉';
    }
  };

  const goToSlide = (index: number) => {
    setCurrentIndex(index);
  };

  return (
    <div
      className={`announcement-banner type-${current.type}`}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="banner-content" onClick={() => onClick?.(current)}>
        <span className="banner-icon">{getTypeIcon(current.type)}</span>
        <div className="banner-text">
          <span className="banner-title">{current.title}</span>
          <span className="banner-message">{current.message}</span>
        </div>
        {current.link && <span className="banner-cta">View →</span>}
      </div>

      {/* Dismiss Button */}
      <button
        className="dismiss-btn"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss?.(current.id);
        }}
      >
        ✕
      </button>

      {/* Pagination Dots */}
      {validAnnouncements.length > 1 && (
        <div className="banner-dots">
          {validAnnouncements.map((_, i) => (
            <button
              key={i}
              className={`dot ${i === currentIndex ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation();
                goToSlide(i);
              }}
            />
          ))}
        </div>
      )}

      {/* Progress Bar */}
      <div className="progress-bar">
        <div
          className={`progress-fill ${isPaused ? 'paused' : ''}`}
          style={{ animationDuration: '5s' }}
        />
      </div>
    </div>
  );
};

export default AnnouncementBanner;
