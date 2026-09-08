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
 * Boot sequence (same as main.tsx — INSTANT RENDER, no spinner):
 *  1. Sentry + WebVitals (synchronous)
 *  2. AntiGravity env-var check (synchronous)
 *  3. MasterBus init (synchronous)
 *  4. IdentityDNA auth init (async, non-blocking)
 *  5. React render IMMEDIATELY — don't wait for async boot
 *
 * Auth: Same-origin Supabase session via shared localStorage key.
 */

import React from 'react';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/club-engine.css';
import './styles/animations.css';
import { initAntiGravity } from './core/AntiGravityBoot';
import { initMasterBus } from './core/MasterBus';
import { initIdentityDNA } from './core/IdentityDNA';
import { initSentry } from './core/SentryInit';
import { initWebVitals } from './core/WebVitals';
import { ROUTER_BASENAME } from './lib/appBase';
import SystemOffline from './core/SystemOffline';
import { ErrorBoundary } from './components/common';
import { reportError } from './utils/errorReporter';

// Prevent double-init when React strict mode re-runs effects
let booted = false;

/**
 * Run synchronous boot phases OUTSIDE of React render cycle.
 * This runs once at module load time — before the component even mounts.
 * IdentityDNA's async getSession() continues in background.
 */
function runBootOnce(): { ok: boolean; status: any } {
  if (booted) return { ok: true, status: null };

  // Global safety net (same as main.tsx)
  window.addEventListener('unhandledrejection', (event) => {
    reportError(event.reason, 'ClubArenaRoot.Unhandled_promise_rejection_caught');
    event.preventDefault();
  });

  // Phase 0: Sentry + WebVitals
  initSentry();
  initWebVitals();

  // Phase 1: AntiGravity env check
  const bootStatus = initAntiGravity();

  if (!bootStatus.antigravityOk) {
    return { ok: false, status: bootStatus };
  }

  // Phase 2: MasterBus (synchronous)
  initMasterBus();

  // Phase 3: IdentityDNA (async, non-blocking — fire and forget)
  initIdentityDNA().catch((err) => {
    reportError(err, 'ClubArenaRoot.IdentityDNA_init_error');
  });

  booted = true;
  return { ok: true, status: bootStatus };
}

// Run boot IMMEDIATELY at module load — not inside useEffect
// This eliminates the extra render cycle (booting → ready) that caused
// the visible spinner flash on re-entry
const bootResult = runBootOnce();

export default function ClubArenaRoot() {
  if (!bootResult.ok) {
    return <SystemOffline status={bootResult.status} />;
  }

  // Render immediately — no spinner, no intermediate state
  return (
    <ErrorBoundary>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
