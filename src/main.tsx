/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — Main Entry Point (ANTI-GRAVITY PROTECTED)
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * 
 * 🚀 ANTI-GRAVITY FAIL-CLOSED:
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
import { initAntiGravity, isSystemOnline, getBootStatus } from './core/AntiGravityBoot';
import { initMasterBus, isMasterBusOnline } from './core/MasterBus';
import { initIdentityDNA, isIdentityDNALoaded } from './core/IdentityDNA';
import SystemOffline from './core/SystemOffline';

// ═══════════════════════════════════════════════════════════════════════════════
// 🚀 ANTI-GRAVITY BOOT SEQUENCE — MUST COMPLETE BEFORE RENDER
// ═══════════════════════════════════════════════════════════════════════════════
async function boot() {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  🎰 CLUB ARENA — BOOT SEQUENCE INITIATED                      ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');

    // PHASE 1: Anti-Gravity Core
    const status = await initAntiGravity();

    // PHASE 2: Master Bus (State Management)
    const busStatus = initMasterBus();

    // PHASE 3: Identity DNA (Auth/User Profile)
    const dnaStatus = await initIdentityDNA();

    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL SYSTEM INTEGRITY CHECK
    // ═══════════════════════════════════════════════════════════════════════════
    console.log('');
    console.log('╔═══════════════════════════════════════════════════════════════╗');
    console.log('║  📊 SYSTEM INTEGRITY REPORT                                   ║');
    console.log('╠═══════════════════════════════════════════════════════════════╣');
    console.log(`║  Anti-Gravity:  ${isSystemOnline() ? '🟢 ONLINE' : '🔴 OFFLINE'}                                   ║`);
    console.log(`║  Master Bus:    ${isMasterBusOnline() ? '🟢 ONLINE' : '🔴 OFFLINE'}                                   ║`);
    console.log(`║  Identity DNA:  ${isIdentityDNALoaded() ? '🟢 LOADED' : '🔴 FAILED'}                                   ║`);
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log('');

    const root = ReactDOM.createRoot(document.getElementById('root')!);

    // ═══════════════════════════════════════════════════════════════════════════
    // ABSOLUTE FAIL-CLOSED DECISION
    // ═══════════════════════════════════════════════════════════════════════════
    if (isSystemOnline() && isMasterBusOnline()) {
        // 🟢 ALL SYSTEMS GO — Render the full app
        console.log('🟢 [HEARTBEAT] All Systems Operational — Rendering Application');
        root.render(
            <React.StrictMode>
                <BrowserRouter>
                    <App />
                </BrowserRouter>
            </React.StrictMode>
        );
    } else {
        // 🔴 FAIL-CLOSED — Only render diagnostic screen
        console.log('🔴 [HEARTBEAT] System Integrity Failure — Rendering Offline Screen');
        root.render(
            <React.StrictMode>
                <SystemOffline status={status} />
            </React.StrictMode>
        );
    }
}

// Execute the boot sequence
boot();

