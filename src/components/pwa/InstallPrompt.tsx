/**
 * ♠ CLUB ARENA — PWA Install Prompt
 * Smart add-to-homescreen prompt for mobile users
 *
 * Dismissal persistence:
 *  - 1st "Later" → 30-day cooldown before showing again
 *  - 2nd "Later" → permanently dismissed (never shows again)
 *  - "Install" clicked → permanently stored as installed
 *  - Also listens for browser 'appinstalled' event as backup
 *  - Detects standalone/installed mode to avoid redundant prompts
 */

import React, { useState, useEffect } from 'react';
import { STORAGE_KEYS } from '../../lib/storage';
import './InstallPrompt.css';
import { reportError } from '../../utils/errorReporter';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export const InstallPrompt: React.FC = () => {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (showPrompt) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    } else {
      setMounted(false);
    }
  }, [showPrompt]);

  useEffect(() => {
    try {
      // Already installed (user clicked Install or appinstalled fired)
      if (localStorage.getItem(STORAGE_KEYS.PWA_INSTALLED)) return;

      // Check if already installed as PWA
      if (window.matchMedia('(display-mode: standalone)').matches) {
        localStorage.setItem(STORAGE_KEYS.PWA_INSTALLED, 'true');
        return;
      }

      // Escalating dismissal logic
      const dismissCount = parseInt(localStorage.getItem(STORAGE_KEYS.PWA_DISMISS_COUNT) || '0');
      if (dismissCount >= 2) return; // Permanently dismissed after 2nd "Later"

      const dismissedAt = localStorage.getItem(STORAGE_KEYS.PWA_PROMPT_DISMISSED);
      if (dismissedAt) {
        const cooldown = 30 * 24 * 60 * 60 * 1000; // 30 days
        if (Date.now() - parseInt(dismissedAt) < cooldown) return;
      }
    } catch (err) {
      reportError(err, 'InstallPrompt.Error');
      // localStorage disabled (Safari private browsing, quota exceeded) — don't show
      return;
    }

    // Detect iOS
    const isIOSDevice = /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
    setIsIOS(isIOSDevice);

    // Listen for beforeinstallprompt event (Android/Desktop Chrome)
    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      // Show prompt after 30 seconds of user engagement
      setTimeout(() => setShowPrompt(true), 30000);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstall);

    // For iOS, show manual instructions after engagement
    if (isIOSDevice) {
      setTimeout(() => setShowPrompt(true), 30000);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
    };
  }, []);

  // Listen for the browser 'appinstalled' event (fires after actual install)
  useEffect(() => {
    const onInstalled = () => {
      try {
        localStorage.setItem(STORAGE_KEYS.PWA_INSTALLED, 'true');
      } catch (err) {
        reportError(err, 'InstallPrompt.Error');
        /* ignore */
      }
      setShowPrompt(false);
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      setShowPrompt(false);
      try {
        if (outcome === 'accepted') {
          localStorage.setItem(STORAGE_KEYS.PWA_INSTALLED, 'true');
        } else {
          const count = parseInt(localStorage.getItem(STORAGE_KEYS.PWA_DISMISS_COUNT) || '0') + 1;
          localStorage.setItem(STORAGE_KEYS.PWA_DISMISS_COUNT, count.toString());
          localStorage.setItem(STORAGE_KEYS.PWA_PROMPT_DISMISSED, Date.now().toString());
        }
      } catch (err) {
        reportError(err, 'InstallPrompt.Error');
        /* localStorage disabled */
      }
    }
  };

  const handleDismiss = () => {
    setShowPrompt(false);
    try {
      const count = parseInt(localStorage.getItem(STORAGE_KEYS.PWA_DISMISS_COUNT) || '0') + 1;
      localStorage.setItem(STORAGE_KEYS.PWA_DISMISS_COUNT, count.toString());
      localStorage.setItem(STORAGE_KEYS.PWA_PROMPT_DISMISSED, Date.now().toString());
    } catch (err) {
      reportError(err, 'InstallPrompt.Error');
      /* localStorage disabled */
    }
  };

  if (!showPrompt) return null;

  return (
    <div className="install-prompt-overlay">
      <div
        className="install-prompt"
        style={{
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(8px)',
          transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        }}
      >
        <button className="prompt-close" onClick={handleDismiss}>
          ✕
        </button>

        <div className="prompt-icon">♠</div>
        <h3>Add Club Arena To Home Screen</h3>
        <p>Get Instant Access With A Native App Experience!</p>

        {isIOS ? (
          <div className="ios-instructions">
            <p>
              Tap The <span className="share-icon">⬆</span> Share Button
            </p>
            <p>
              Then Tap <strong>"Add To Home Screen"</strong>
            </p>
          </div>
        ) : (
          <div className="prompt-actions">
            <button className="btn-install" onClick={handleInstall}>
              Install App
            </button>
            <button className="btn-later" onClick={handleDismiss}>
              Maybe Later
            </button>
          </div>
        )}

        <div className="prompt-benefits">
          <span>✓ Instant Launch</span>
          <span>✓ Works Offline</span>
          <span>✓ Push Notifications</span>
        </div>
      </div>
    </div>
  );
};

export default InstallPrompt;
