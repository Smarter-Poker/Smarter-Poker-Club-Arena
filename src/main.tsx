/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Main Entry Point (ANTI-GRAVITY PROTECTED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Smarter Poker Platform
 *
 *  ANTI-GRAVITY INSTANT RENDER:
 * React renders IMMEDIATELY after synchronous env-var validation.
 * MasterBus + IdentityDNA auth listener init BEFORE render (both sync).
 * IdentityDNA's async getSession() runs in background — does not block paint.
 *
 * BOOT SEQUENCE:
 * 1. Anti-Gravity Core (Env check — synchronous)
 * 2. Master Bus (State Management — synchronous)
 * 3. Identity DNA (Auth listener sync + getSession async)
 * 4. root.render() — React paints immediately
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
import { reportError } from './utils/errorReporter';

// ═══════════════════════════════════════════════════════════════════════════════
//  GLOBAL SAFETY NET — Catch unhandled promise rejections from service throws
// ═══════════════════════════════════════════════════════════════════════════════
// Many services use `throw error` which creates unhandled rejections when called
// from event handlers, bus listeners, or realtime callbacks without try/catch.
// This prevents those from silently crashing the app or causing undefined state.
window.addEventListener('unhandledrejection', (event) => {
  // Log but don't crash — the page's error state should handle degraded display
  reportError(event.reason, 'main.Unhandled_promise_rejection_caught');
  // Prevent the default browser behavior (console error + potential crash)
  event.preventDefault();
});

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
  // PHASE 2: MasterBus — synchronous, instant. Must complete before render
  // so cross-store sync handlers are ready when auth events fire.
  initMasterBus();

  // PHASE 3: Start IdentityDNA BEFORE render (fire-and-forget).
  // setupAuthListener() runs synchronously at the start of init(), which
  // guarantees the onAuthStateChange listener is registered BEFORE any
  // React useEffect can call setSession() (useEffects run after paint).
  // The async getSession() part continues in the background.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const identityPromise = initIdentityDNA().catch((err) => {
    reportError(err, 'main.IdentityDNA_init_error_app_already_rende');
  });

  // RENDER IMMEDIATELY — don't wait for IdentityDNA's async getSession().
  // The app has AuthGuard, ErrorBoundary, Connection Watchdog, and Offline
  // Banner that gracefully handle degraded state. Blocking rendering for
  // getSession() caused 2-10s blank screens — completely unacceptable.
  root.render(
    <ErrorBoundary>
      <BrowserRouter basename="/hub/club-arena">
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );
} else {
  // ONLY show SystemOffline for missing env vars (build/deploy misconfiguration)
  reportError(new Error('[BOOT] Missing environment variables — rendering diagnostic screen'), 'main.Missing_environment_variables__rendering');
  root.render(<SystemOffline status={bootStatus} />);
}
