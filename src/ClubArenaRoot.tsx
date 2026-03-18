/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ClubArenaRoot — Entry point for mounting inside Next.js (World Hub)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This component replaces the iframe-based integration. The World Hub's
 * catch-all page (`pages/hub/club-arena/[[...slug]].js`) dynamically imports
 * this component with ssr: false, rendering the Club Arena SPA client-side
 * within the Next.js application.
 *
 * Boot sequence (same as main.tsx, minus iframe code):
 *  1. Sentry + WebVitals (synchronous)
 *  2. AntiGravity env-var check (synchronous)
 *  3. MasterBus init (synchronous)
 *  4. IdentityDNA auth init (async, non-blocking)
 *  5. React render with BrowserRouter
 *
 * Auth: Same-origin Supabase session via shared localStorage key.
 */

import React, { useEffect, useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/club-engine.css';
import './styles/animations.css';
import { initAntiGravity } from './core/AntiGravityBoot';
import { initMasterBus } from './core/MasterBus';
import { initIdentityDNA } from './core/IdentityDNA';
import { initSentry } from './core/SentryInit';
import { initWebVitals } from './core/WebVitals';
import SystemOffline from './core/SystemOffline';
import { ErrorBoundary } from './components/common';

// Prevent double-init when React strict mode re-runs effects
let booted = false;

export default function ClubArenaRoot() {
  const [status, setStatus] = useState<'booting' | 'ready' | 'offline'>('booting');
  const [bootStatus, setBootStatus] = useState<any>(null);

  useEffect(() => {
    if (booted) {
      setStatus('ready');
      return;
    }

    // Global safety net (same as main.tsx)
    window.addEventListener('unhandledrejection', (event) => {
      console.error('[GLOBAL] Unhandled promise rejection caught:', event.reason);
      event.preventDefault();
    });

    // Phase 0: Sentry + WebVitals
    initSentry();
    initWebVitals();

    // Phase 1: AntiGravity env check
    const boot = initAntiGravity();
    setBootStatus(boot);

    if (!boot.antigravityOk) {
      setStatus('offline');
      return;
    }

    // Phase 2: MasterBus (synchronous)
    initMasterBus();

    // Phase 3: IdentityDNA (async, non-blocking)
    initIdentityDNA().catch((err) => {
      console.error('[ClubArenaRoot] IdentityDNA init error:', err);
    });

    booted = true;
    setStatus('ready');
  }, []);

  if (status === 'booting') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          background: '#0a0a1a',
          color: '#fff',
          fontFamily: 'Inter, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: 40,
              height: 40,
              border: '3px solid #333',
              borderTopColor: '#2374E1',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 16px',
            }}
          />
          <p>Loading Club Arena...</p>
        </div>
      </div>
    );
  }

  if (status === 'offline') {
    return <SystemOffline status={bootStatus} />;
  }

  return (
    <ErrorBoundary>
      <BrowserRouter basename="/hub/club-arena">
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
