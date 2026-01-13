/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Main Entry Point (HARDENED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone + Better | Clubs & Unions
 * Brand: Blue, White, Black
 * 
 * 🚀 ANTI-GRAVITY AUTO-BOOT (HARD REQUIREMENT)
 * - Boot is AWAITED before ANY render (no async race conditions)
 * - If boot fails, ONLY SystemOffline renders (absolute fail-closed)
 * - No fallback render of <App /> is permitted
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';

// 🚀 ANTI-GRAVITY BOOT (REQUIRED)
import { initAntiGravity, isSystemOnline } from './core/AntiGravityBoot';
import SystemOffline from './core/SystemOffline';

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT SEQUENCE (SYNCHRONOUS GATE)
// ═══════════════════════════════════════════════════════════════════════════════
async function boot(): Promise<void> {
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ PHASE 1: AWAIT AntiGravity initialization                              │
  // │ NO rendering occurs until this completes (no race conditions)          │
  // └─────────────────────────────────────────────────────────────────────────┘
  const status = await initAntiGravity();

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ PHASE 2: Create React root                                             │
  // └─────────────────────────────────────────────────────────────────────────┘
  const rootElement = document.getElementById('root');
  if (!rootElement) {
    console.error('[FATAL] Root element not found');
    return;
  }
  const root = ReactDOM.createRoot(rootElement);

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ PHASE 3: ABSOLUTE FAIL-CLOSED DECISION                                 │
  // │ If isSystemOnline() returns false, ONLY SystemOffline renders.         │
  // │ There is NO fallback path to <App />.                                  │
  // └─────────────────────────────────────────────────────────────────────────┘
  if (isSystemOnline()) {
    // ✅ SYSTEM ONLINE: All checks passed
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>
    );
  } else {
    // 🔴 FAIL-CLOSED: Missing config or Supabase unreachable
    // ONLY this branch renders if ANY check fails
    root.render(
      <React.StrictMode>
        <SystemOffline status={status} />
      </React.StrictMode>
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXECUTE BOOT (Immediate)
// ═══════════════════════════════════════════════════════════════════════════════
boot();
