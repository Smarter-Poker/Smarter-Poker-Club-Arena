/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Main Entry Point (ANTI-GRAVITY PROTECTED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * 
 * 🚀 ANTI-GRAVITY FAIL-CLOSED:
 * This entry point AWAITS boot completion before ANY rendering.
 * If boot fails, ONLY the SystemOffline screen renders.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/club-engine.css';
import { initAntiGravity, isSystemOnline, getBootStatus } from './core/AntiGravityBoot';
import SystemOffline from './core/SystemOffline';

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 ANTI-GRAVITY BOOT SEQUENCE — MUST COMPLETE BEFORE RENDER
// ═══════════════════════════════════════════════════════════════════════════════
async function boot() {
    const status = await initAntiGravity();
    const root = ReactDOM.createRoot(document.getElementById('root')!);

    // ═══════════════════════════════════════════════════════════════════════════
    // ABSOLUTE FAIL-CLOSED DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    if (isSystemOnline()) {
        // 🟢 ALL SYSTEMS GO — Render the full app
        console.log('🟢 [ANTIGRAVITY] HEARTBEAT: All Systems Operational');
        root.render(
            <React.StrictMode>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </React.StrictMode>
        );
    } else {
        // 🔴 FAIL-CLOSED — Only render diagnostic screen
        console.log('🔴 [ANTIGRAVITY] HEARTBEAT: System Offline');
        root.render(
            <React.StrictMode>
                <SystemOffline status={status} />
            </React.StrictMode>
        );
    }
}

// Execute the boot sequence
boot();
