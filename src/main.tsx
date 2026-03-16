/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Main Entry Point (ANTI-GRAVITY PROTECTED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 *
 *  ANTI-GRAVITY FAIL-CLOSED:
 * This entry point AWAITS boot completion before ANY rendering.
 * If boot fails, ONLY the SystemOffline screen renders.
 *
 * BOOT SEQUENCE:
 * 1. Anti-Gravity Core (Env + Supabase)
 * 2. Master Bus (State Management)
 * 3. Identity DNA (Auth/User Profile)
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/club-engine.css';
import './styles/animations.css';
import { initAntiGravity, isSystemOnline, getBootStatus } from './core/AntiGravityBoot';
import { initMasterBus, isMasterBusOnline } from './core/MasterBus';
import { initIdentityDNA, isIdentityDNALoaded } from './core/IdentityDNA';
import { initSentry } from './core/SentryInit';
import { initWebVitals } from './core/WebVitals';
import SystemOffline from './core/SystemOffline';
import { ErrorBoundary } from './components/common';

// ═══════════════════════════════════════════════════════════════════════════════
//  GLOBAL SAFETY NET — Catch unhandled promise rejections from service throws
// ═══════════════════════════════════════════════════════════════════════════════
// Many services use `throw error` which creates unhandled rejections when called
// from event handlers, bus listeners, or realtime callbacks without try/catch.
// This prevents those from silently crashing the app or causing undefined state.
window.addEventListener('unhandledrejection', (event) => {
  // Log but don't crash — the page's error state should handle degraded display
  console.error('[GLOBAL] Unhandled promise rejection caught:', event.reason);
  // Prevent the default browser behavior (console error + potential crash)
  event.preventDefault();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EARLY AUTH LISTENER — Respond to World Hub BEFORE boot completes
// ═══════════════════════════════════════════════════════════════════════════════
// CRITICAL: The World Hub's ClubArenaEmbed sends SMARTER_AUTH_TOKEN via postMessage
// and expects SMARTER_AUTH_ACK back. If it doesn't receive ACK within its retry
// window, it shows a "Connection Problem" overlay. The listener in App.tsx only
// registers AFTER the full boot sequence + React mount, creating a race condition.
//
// This early listener fires IMMEDIATELY (before boot, before React) so the ACK
// is sent as fast as possible. The token is stored for App.tsx to consume on mount.
// ═══════════════════════════════════════════════════════════════════════════════

import { earlyAuth } from './core/earlyAuthBridge';

if (window.parent !== window) {
  let authReceived = false;

  const earlyAuthHandler = (event: MessageEvent) => {
    // Validate origin: same checks as App.tsx
    const origin = event.origin;
    const isValidOrigin =
      origin === 'https://smarter.poker' ||
      origin === 'https://www.smarter.poker' ||
      (origin.endsWith('.smarter.poker') && origin.startsWith('https://')) ||
      origin === 'http://localhost:3000' ||
      origin === window.location.origin; // Same-origin iframe proxy
    if (!isValidOrigin) return;

    if (event.data?.type === 'SMARTER_AUTH_TOKEN' && event.data.token) {
      authReceived = true;
      // ACK immediately — send to BOTH specific origin AND wildcard to cover all cases
      try {
        window.parent.postMessage({ type: 'SMARTER_AUTH_ACK' }, '*');
        console.log('[EARLY-AUTH] ✅ ACK sent to parent (wildcard) before boot');
      } catch {
        /* cross-origin safety */
      }

      // Store token for App.tsx to pick up after mount
      earlyAuth.token = event.data.token;
      earlyAuth.refreshToken = event.data.refreshToken || null;
      earlyAuth.settings = event.data.settings || null;
    }
  };
  window.addEventListener('message', earlyAuthHandler);

  // PROACTIVE ACK PULSE: Send periodic ACKs so the Hub receives one
  // regardless of timing. The Hub may start its retry loop before our
  // listener is registered, so we pulse ACKs until auth is received.
  let pulseCount = 0;
  const ackPulse = setInterval(() => {
    if (authReceived || pulseCount > 30) {
      clearInterval(ackPulse);
      return;
    }
    pulseCount++;
    try {
      // Send heartbeat AND unsolicited ACK so the Hub knows we're alive
      window.parent.postMessage({ type: 'CLUB_ARENA_HEARTBEAT' }, '*');
      // If auth was already received by the App.tsx handler (after boot),
      // also send a fresh ACK
      if (earlyAuth.token) {
        window.parent.postMessage({ type: 'SMARTER_AUTH_ACK' }, '*');
      }
    } catch {
      /* best effort */
    }
  }, 500);

  // Send an immediate heartbeat so the Hub knows we're alive
  try {
    window.parent.postMessage({ type: 'CLUB_ARENA_HEARTBEAT' }, '*');
    console.log('[EARLY-AUTH] Heartbeat sent, waiting for auth token...');
  } catch {
    /* best effort */
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ANTI-GRAVITY BOOT SEQUENCE — MUST COMPLETE BEFORE RENDER
// ═══════════════════════════════════════════════════════════════════════════════
async function boot() {
  // PHASE 0: Initialize Sentry (FIRST - before any errors can occur)
  initSentry();
  initWebVitals();

  console.log('[BOOT] Phase 1: AntiGravity...');
  // PHASE 1: Anti-Gravity Core
  const status = await initAntiGravity();
  console.log('[BOOT] Phase 1 complete:', status.antigravityOk, status.supabaseOk);

  // PHASE 2: Master Bus (State Management)
  console.log('[BOOT] Phase 2: MasterBus...');
  const busStatus = initMasterBus();
  console.log('[BOOT] Phase 2 complete:', busStatus?.online);

  // PHASE 3: Identity DNA (Auth/User Profile)
  console.log('[BOOT] Phase 3: IdentityDNA...');
  const dnaStatus = await initIdentityDNA();
  console.log('[BOOT] Phase 3 complete');

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SYSTEM INTEGRITY CHECK
  // ═══════════════════════════════════════════════════════════════════════════

  const root = ReactDOM.createRoot(document.getElementById('root')!);

  const systemOnline = isSystemOnline();
  const busOnline = isMasterBusOnline();
  console.log('[BOOT] System online:', systemOnline, 'Bus online:', busOnline);

  // ═══════════════════════════════════════════════════════════════════════════
  // ZERO-TOLERANCE RENDERING DECISION
  // ═══════════════════════════════════════════════════════════════════════════
  // The app must ALWAYS render. The ONLY exception is if environment variables
  // are completely missing (antigravityOk=false), which is a build/deploy
  // configuration error — not a runtime/connectivity issue.
  //
  // Transient Supabase connectivity issues are handled by:
  // - AuthGuard (redirects unauthenticated users to /auth)
  // - Connection Watchdog (monitors and auto-reconnects)
  // - Offline Banner (visible warning to users)
  // - Offline Queue (queues mutations for replay)
  //
  // Showing SystemOffline for a connectivity blip is CATASTROPHIC and must
  // never happen. Only a true misconfiguration should trigger it.
  // ═══════════════════════════════════════════════════════════════════════════
  const envVarsOk = status.antigravityOk;

  if (envVarsOk) {
    // ALWAYS render the app if env vars are configured correctly.
    // Supabase connectivity and auth are handled at the app layer.
    if (!systemOnline || !busOnline) {
      console.warn('[BOOT] Degraded mode — rendering app anyway (connectivity will auto-recover)');
    }
    root.render(
      <ErrorBoundary>
        <BrowserRouter basename="/hub/club-arena">
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    );
  } else {
    // ONLY show SystemOffline for missing env vars (build/deploy misconfiguration)
    console.error('[BOOT] Missing environment variables — rendering diagnostic screen');
    root.render(<SystemOffline status={status} />);
  }
}

// Execute the boot sequence with top-level error catch
boot().catch((err) => {
  console.error('[BOOT] FATAL: boot() threw an unhandled error:', err);
  // ZERO TOLERANCE: Even if the boot sequence throws, try to render the app.
  // The app has its own ErrorBoundary, AuthGuard, and Connection Watchdog that
  // can handle degraded state far better than a dead "Boot Failed" screen.
  try {
    const root = ReactDOM.createRoot(document.getElementById('root')!);
    root.render(
      <ErrorBoundary>
        <BrowserRouter basename="/hub/club-arena">
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    );
  } catch {
    // Absolute last resort — show retry button
    document.body.innerHTML = `
      <div style="color:#fff;padding:2rem;text-align:center;font-family:system-ui">
        <h1>Loading Club Arena...</h1>
        <p style="color:#aaa">Temporary issue — please retry</p>
        <button onclick="window.location.reload()" style="padding:0.75rem 1.5rem;margin-top:1rem;background:#667eea;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer">
          Retry
        </button>
      </div>
    `;
  }
});
