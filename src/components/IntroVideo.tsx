/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Intro Video Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 * Plays a FULL SCREEN intro video for at least 3 seconds.
 * Video plays at normal speed. Skip button only appears after minimum time.
 * Auto-dismisses when video ends (if after minimum) or after timeout.
 */

import React, { useState, useEffect, useRef } from 'react';
import './IntroVideo.css';

interface IntroVideoProps {
  videoSrc: string;
  minDuration?: number; // Minimum display time in ms (default 3000)
  maxDuration?: number; // Maximum display time in ms (default 10000)
  onComplete: () => void;
}

export default function IntroVideo({
  videoSrc,
  minDuration = 3000,
  maxDuration = 10000,
  onComplete,
}: IntroVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [fadeOut, setFadeOut] = useState(false);
  const [canSkip, setCanSkip] = useState(false);
  const [videoEnded, setVideoEnded] = useState(false);
  const completedRef = useRef(false);

  const completeIntro = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    setFadeOut(true);
    setTimeout(onComplete, 500); // Allow fade animation
  };

  useEffect(() => {
    // Enable skip button after minimum duration
    const skipTimer = setTimeout(() => {
      setCanSkip(true);
      // If video already ended, complete now
      if (videoEnded) {
        completeIntro();
      }
    }, minDuration);

    // Maximum duration fallback
    const maxTimer = setTimeout(() => {
      completeIntro();
    }, maxDuration);

    // Play the video at 1x speed
    if (videoRef.current) {
      videoRef.current.playbackRate = 1.0; // Normal speed
      videoRef.current.play().catch((err) => {
        console.warn('Video autoplay blocked:', err);
        // If autoplay is blocked, wait for minimum then complete
        setTimeout(completeIntro, minDuration);
      });
    }

    return () => {
      clearTimeout(skipTimer);
      clearTimeout(maxTimer);
    };
  }, [minDuration, maxDuration, videoEnded]);

  const handleVideoEnd = () => {
    setVideoEnded(true);
    // Only complete if we've passed minimum duration
    if (canSkip) {
      completeIntro();
    }
  };

  const handleSkip = () => {
    if (canSkip) {
      completeIntro();
    }
  };

  return (
    <div className={`intro-video-overlay ${fadeOut ? 'fade-out' : ''}`}>
      <video
        ref={videoRef}
        className="intro-video"
        src={videoSrc}
        muted
        playsInline
        onEnded={handleVideoEnd}
      />

      {/* Skip button - only visible after minimum duration */}
      {canSkip && (
        <button className="intro-skip-btn" onClick={handleSkip}>
          Skip →
        </button>
      )}

      {/* Loading indicator */}
      <div className="intro-loading-hint">
        {canSkip ? 'Club Arena Ready' : 'Loading Club Arena...'}
      </div>
    </div>
  );
}
