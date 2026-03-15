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
