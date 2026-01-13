/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — Main Entry Point
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone + Better | Clubs & Unions
 * Brand: Blue, White, Black
 * 
 * 🚀 ANTI-GRAVITY AUTO-BOOT (HARD REQUIREMENT)
 * The app will NOT render until AntiGravity initializes.
 * If boot fails, a fail-closed screen is shown.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';

// 🚀 ANTI-GRAVITY BOOT
import { initAntiGravity, isSystemOnline, getBootStatus } from './core/AntiGravityBoot';
import SystemOffline from './core/SystemOffline';

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT SEQUENCE
// ═══════════════════════════════════════════════════════════════════════════════
async function boot() {
  // Run AntiGravity initialization BEFORE rendering
  const status = await initAntiGravity();

  const root = ReactDOM.createRoot(document.getElementById('root')!);

  if (isSystemOnline()) {
    // ✅ SYSTEM ONLINE: Render App
    root.render(
      <React.StrictMode>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </React.StrictMode>
    );
  } else {
    // 🔴 FAIL-CLOSED: Render Offline Screen
    root.render(
      <React.StrictMode>
        <SystemOffline status={status} />
      </React.StrictMode>
    );
  }
}

// Execute Boot
boot();
