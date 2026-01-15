/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎰 CLUB ENGINE — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone — Better
 * Root application with routing, auth guards, and global providers
 */

import { Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';

// Layouts
import AppLayout from './components/layouts/AppLayout';

// Auth Guards
import { AuthGuard, GuestGuard } from './components/auth/AuthGuard';

// Pages (lazy loaded for performance)
const AuthPage = lazy(() => import('./pages/AuthPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const LobbyPage = lazy(() => import('./pages/LobbyPage'));
const ClubsPage = lazy(() => import('./pages/ClubsPage'));
const ClubDetailPage = lazy(() => import('./pages/ClubDetailPage'));
const CreateClubPage = lazy(() => import('./pages/CreateClubPage'));
const AgentManagementPage = lazy(() => import('./pages/AgentManagementPage'));
const TablePage = lazy(() => import('./pages/TablePage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const UnionsPage = lazy(() => import('./pages/UnionsPage'));
const UnionDetailPage = lazy(() => import('./pages/UnionDetailPage'));
const CreateUnionPage = lazy(() => import('./pages/CreateUnionPage'));
const SettlementPage = lazy(() => import('./pages/SettlementPage'));

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
                {/* ═══════════════════════════════════════════════════════════════
                    PUBLIC ROUTES (No Auth Required)
                ═══════════════════════════════════════════════════════════════ */}

                {/* Auth Page - Only accessible when NOT logged in */}
                <Route
                    path="/auth"
                    element={
                        <GuestGuard>
                            <AuthPage />
                        </GuestGuard>
                    }
                />

                {/* ═══════════════════════════════════════════════════════════════
                    PROTECTED ROUTES (Auth Required)
                ═══════════════════════════════════════════════════════════════ */}

                {/* HomePage - Standalone without Shell, requires auth */}
                <Route
                    path="/"
                    element={
                        <AuthGuard>
                            <HomePage />
                        </AuthGuard>
                    }
                />

                {/* Protected routes with AppLayout shell */}
                <Route element={<AppLayout />}>
                    {/* Lobby */}
                    <Route
                        path="lobby"
                        element={
                            <AuthGuard>
                                <LobbyPage />
                            </AuthGuard>
                        }
                    />

                    {/* Clubs */}
                    <Route
                        path="clubs"
                        element={
                            <AuthGuard>
                                <ClubsPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="clubs/create"
                        element={
                            <AuthGuard>
                                <CreateClubPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="clubs/:clubId"
                        element={
                            <AuthGuard>
                                <ClubDetailPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="clubs/:clubId/agents"
                        element={
                            <AuthGuard>
                                <AgentManagementPage />
                            </AuthGuard>
                        }
                    />

                    {/* Unions */}
                    <Route
                        path="unions"
                        element={
                            <AuthGuard>
                                <UnionsPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="unions/create"
                        element={
                            <AuthGuard>
                                <CreateUnionPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="unions/:unionId"
                        element={
                            <AuthGuard>
                                <UnionDetailPage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="unions/:unionId/settlement"
                        element={
                            <AuthGuard>
                                <SettlementPage />
                            </AuthGuard>
                        }
                    />

                    {/* Table */}
                    <Route
                        path="table/:tableId"
                        element={
                            <AuthGuard>
                                <TablePage />
                            </AuthGuard>
                        }
                    />

                    {/* User */}
                    <Route
                        path="profile"
                        element={
                            <AuthGuard>
                                <ProfilePage />
                            </AuthGuard>
                        }
                    />
                    <Route
                        path="settings"
                        element={
                            <AuthGuard>
                                <SettingsPage />
                            </AuthGuard>
                        }
                    />
                </Route>
            </Routes>
        </Suspense>
    );
}
