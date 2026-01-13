/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * Root application with routing and global providers
 */

import { Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';

// Layouts
import AppLayout from './components/layouts/AppLayout';

// Pages (lazy loaded for performance)
const LobbyPage = lazy(() => import('./pages/LobbyPage'));
const ClubsPage = lazy(() => import('./pages/ClubsPage'));
const ClubDetailPage = lazy(() => import('./pages/ClubDetailPage'));
const TablePage = lazy(() => import('./pages/TablePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

// Loading fallback
function LoadingSpinner() {
    return (
        <div className="loading-container">
            <div className="spinner" />
            <p style={{ marginTop: '1rem', color: 'var(--text-secondary)' }}>Loading...</p>
        </div>
    );
}

export default function App() {
    return (
        <Suspense fallback={<LoadingSpinner />}>
            <Routes>
                <Route path="/" element={<AppLayout />}>
                    <Route index element={<LobbyPage />} />
                    <Route path="clubs" element={<ClubsPage />} />
                    <Route path="clubs/:clubId" element={<ClubDetailPage />} />
                    <Route path="table/:tableId" element={<TablePage />} />
                    <Route path="profile" element={<ProfilePage />} />
                    <Route path="settings" element={<SettingsPage />} />
                </Route>
            </Routes>
        </Suspense>
    );
}
