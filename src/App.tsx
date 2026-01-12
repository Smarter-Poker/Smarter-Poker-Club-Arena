/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone + Better | Clubs & Unions System
 */

import { Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import Shell from './components/Shell';

// Pages (lazy loaded)
const HomePage = lazy(() => import('./pages/HomePage'));
const ClubsPage = lazy(() => import('./pages/ClubsPage'));
const ClubDetailPage = lazy(() => import('./pages/ClubDetailPage'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const TournamentPage = lazy(() => import('./pages/TournamentPage'));
const TablePage = lazy(() => import('./pages/TablePage'));
const UnionsPage = lazy(() => import('./pages/UnionsPage'));
const UnionDetailPage = lazy(() => import('./pages/UnionDetailPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

// Loading
function Loader() {
  return (
    <div className="loader-container">
      <div className="loader-spinner" />
      <p>Loading Club Arena...</p>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Loader />}>
      <Routes>
        <Route path="/" element={<Shell />}>
          <Route index element={<HomePage />} />
          <Route path="clubs" element={<ClubsPage />} />
          <Route path="clubs/:clubId" element={<ClubDetailPage />} />
          <Route path="clubs/:clubId/agents" element={<AgentPage />} />
          <Route path="clubs/:clubId/tournaments" element={<TournamentPage />} />
          <Route path="clubs/:clubId/tournaments/:tournamentId" element={<TournamentPage />} />
          <Route path="clubs/:clubId/table/:tableId" element={<TablePage />} />
          <Route path="play" element={<TablePage />} /> {/* Direct demo access */}
          <Route path="unions" element={<UnionsPage />} />
          <Route path="unions/:unionId" element={<UnionDetailPage />} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
