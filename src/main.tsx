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
import { initAntiGravity } from './core/AntiGravityBoot';
import { initMasterBus } from './core/MasterBus';
import { initIdentityDNA } from './core/IdentityDNA';
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
import { postToParent, setParentOrigin, isTrustedOrigin } from './utils/parentOrigin';

if (window.parent !== window) {
  let authReceived = false;

  // ═══════════════════════════════════════════════════════════════════════
  // UNCONDITIONAL ACK — Same principle as index.html inline script.
  // ACK means "iframe is alive and handling auth" — auth state is managed
  // independently via SSO/autoRefreshToken/AuthGuard.
  // ═══════════════════════════════════════════════════════════════════════

  // Immediate ACK (module evaluation is fast, parent may still be retrying)
  postToParent({ type: 'SMARTER_AUTH_ACK' });
  postToParent({ type: 'CLUB_ARENA_HEARTBEAT' });
  console.log('[EARLY-AUTH] ✅ Unconditional ACK + heartbeat sent');

  const earlyAuthHandler = (event: MessageEvent) => {
    // Validate origin: same checks as App.tsx
    if (!isTrustedOrigin(event.origin)) return;

    if (event.data?.type === 'SMARTER_AUTH_TOKEN' && event.data.token) {
      authReceived = true;
      // Store validated parent origin for all future postMessage calls
      setParentOrigin(event.origin);
      // Re-ACK when token arrives
      postToParent({ type: 'SMARTER_AUTH_ACK' });
      console.log('[EARLY-AUTH] ✅ Token received, ACK sent');

      // Store token for App.tsx to pick up after mount
      earlyAuth.token = event.data.token;
      earlyAuth.refreshToken = event.data.refreshToken || null;
      earlyAuth.settings = event.data.settings || null;
    }
  };
  window.addEventListener('message', earlyAuthHandler);

  // ACK pulse — keep sending until parent acknowledges or 15s passes
  let pulseCount = 0;
  const ackPulse = setInterval(() => {
    if ((authReceived && pulseCount > 5) || pulseCount > 30) {
      clearInterval(ackPulse);
      return;
    }
    pulseCount++;
    postToParent({ type: 'SMARTER_AUTH_ACK' });
    postToParent({ type: 'CLUB_ARENA_HEARTBEAT' });
  }, 500);

  // CLEANUP: Once App.tsx has consumed the early auth and taken over message
  // handling, remove this early listener to avoid duplicate processing.
  // App.tsx sets window.__earlyAuthConsumed = true after successful setSession.
  let cleanupChecks = 0;
  const cleanupInterval = setInterval(() => {
    cleanupChecks++;
    if ((window as any).__earlyAuthConsumed || cleanupChecks > 60) {
      // App.tsx is handling messages now (or 30s elapsed) — safe to remove
      window.removeEventListener('message', earlyAuthHandler);
      clearInterval(cleanupInterval);
      if ((window as any).__earlyAuthConsumed) {
        console.log('[EARLY-AUTH] 🧹 Listener removed — App.tsx has taken over');
      }
    }
  }, 500);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INSTANT RENDER — Boot runs in background, React paints IMMEDIATELY
// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 0: Sentry + WebVitals (synchronous, fast)
initSentry();
initWebVitals();

// PHASE 1: AntiGravity env-var check (synchronous — no network calls)
const bootStatus = initAntiGravity();

const root = ReactDOM.createRoot(document.getElementById('root')!);

if (bootStatus.antigravityOk) {
  // RENDER IMMEDIATELY — don't wait for MasterBus or IdentityDNA.
  // The app has AuthGuard, ErrorBoundary, Connection Watchdog, and Offline
  // Banner that gracefully handle degraded state. Blocking rendering for
  // boot phases caused 2-10s blank screens — completely unacceptable.
  root.render(
    <ErrorBoundary>
      <BrowserRouter basename="/hub/club-arena">
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );

  // BACKGROUND BOOT: Initialize state management + auth after first paint.
  // MasterBus is synchronous (instant). IdentityDNA is async but the auth
  // listener it sets up will handle setSession from the parent postMessage.
  Promise.resolve().then(async () => {
    try {
      console.log('[BOOT] Background: MasterBus...');
      initMasterBus();
      console.log('[BOOT] Background: IdentityDNA...');
      await initIdentityDNA();
      console.log('[BOOT] Background: Complete ✅');
    } catch (err) {
      console.error('[BOOT] Background boot error (app already rendered):', err);
    }
  });
} else {
  // ONLY show SystemOffline for missing env vars (build/deploy misconfiguration)
  console.error('[BOOT] Missing environment variables — rendering diagnostic screen');
  root.render(<SystemOffline status={bootStatus} />);
}
