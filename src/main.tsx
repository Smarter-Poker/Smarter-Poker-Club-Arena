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

// Cache-bust token 2026-04-15-v7 — test atomic bash deploy loop
const __CACHE_BUST_V7__ = '2026-04-15-v7';
void __CACHE_BUST_V7__;

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOT SENTINEL (Dan 2026-04-17)
//  Flip this flag the INSTANT main.tsx's module evaluates. The self-heal script
//  in index.html checks for this — if it's set, React has started (even if it's
//  still pulling lazy chunks), and the script stands down instead of reloading.
//  Without this sentinel, mobile cold boots were reload-looping every ~20s on
//  phones that took more than 2.5s to mount 100+ code-split chunks.
// ═══════════════════════════════════════════════════════════════════════════════
(window as any).__CLUB_ARENA_BOOTING__ = true;

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/club-engine.css';
import './styles/animations.css';
import './styles/metallic-popups.css';
// LAST of the global sheets on purpose: the reduced-motion rule is the final
// word on animation, and importing it after the rest keeps its !important
// declarations from being read before the sheets they moderate.
import './styles/reducedMotion.css';
// IMPROVEMENT PASS 2026-08-19: ChipAnimations.css and CardAnimations.css
// deleted — ~1,400 lines of keyframes/selectors with ZERO component
// consumers (chip-bet--from-seat-*, community-card--flop-*, card--folding,
// chip--scatter-* etc. were never emitted by any TSX). The live table
// animations all live in their component stylesheets.
import { initAntiGravity } from './core/AntiGravityBoot';
import { initMasterBus } from './core/MasterBus';
import { initIdentityDNA } from './core/IdentityDNA';
import { initSentry } from './core/SentryInit';
import { initWebVitals } from './core/WebVitals';
import SystemOffline from './core/SystemOffline';
import { ErrorBoundary } from './components/common';
import { reportError } from './utils/errorReporter';
import { hasLocalSession } from './lib/authUtils';
import {
  clearChunkRecoveryState,
  installVitePreloadErrorRecovery,
  recoverFromStaleChunk,
} from './utils/lazyWithRetry';

// Install before any fire-and-forget dynamic import below. React routes have
// lazyWithRetry; these boot services did not, so a cached index.html could ask
// for a just-retired hash and leave a working page reporting a critical error.
installVitePreloadErrorRecovery();

function handleBootImportError(error: unknown, context: string): void {
  void recoverFromStaleChunk(error).then((recovering) => {
    if (!recovering) reportError(error, context);
  });
}

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

  // PHASE 3.5: warm the lobby's first query NOW.
  //
  // PERF 2026-08-23. getUserMemberships() is the first thing the app asks the
  // network for, and nothing could ask for it until React had mounted,
  // resolved the route and loaded HomePage's chunk - several hundred
  // milliseconds on a phone with the connection sitting idle. Starting it here
  // overlaps that request with React's own start-up; ClubsService de-duplicates
  // in flight, so HomePage's call joins this one instead of making a second.
  //
  // Only with a local session: a signed-out visitor has nothing to fetch.
  // Fire-and-forget, and it swallows its own errors - whoever asks next sees
  // the real failure through the normal path.
  if (hasLocalSession()) {
    void import('./services/ClubsService')
      .then(({ warmUserMemberships }) => {
        clearChunkRecoveryState();
        return warmUserMemberships();
      })
      .catch((err) => handleBootImportError(err, 'main.Membership_warm_start_non_blocking'));
  }

  // PHASE 4: Activation-funnel tracker (Phase 5.1.2b). Fire-and-forget;
  // subscribes to MasterBus + IdentityDNA for first_table_seat,
  // first_hand_played, first_session_of_30min. No-ops if VITE_POSTHOG_KEY
  // is unset. Never throws out — all handlers swallow their own errors.
  void import('./lib/funnelTracker')
    .then(({ startFunnelTracker }) => {
      clearChunkRecoveryState();
      return startFunnelTracker();
    })
    .catch((err) => handleBootImportError(err, 'main.FunnelTracker_init_error_non_blocking'));

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
  reportError(
    new Error('[BOOT] Missing environment variables - rendering diagnostic screen'),
    'main.Missing_environment_variables__rendering'
  );
  root.render(<SystemOffline status={bootStatus} />);
}
