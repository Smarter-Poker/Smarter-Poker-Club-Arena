/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * ♠ CLUB ARENA — App Component
 * ═══════════════════════════════════════════════════════════════════════════════
 * PokerBros Clone + Better | Clubs & Unions System
 * PLAY CHIPS ONLY - No Real Money
 */

import { Routes, Route } from 'react-router-dom';
import { Suspense, lazy } from 'react';
import Shell from './components/Shell';
import TermsGate from './components/auth/TermsGate';

// Pages (lazy loaded)
const HomePage = lazy(() => import('./pages/HomePage'));
const ClubsPage = lazy(() => import('./pages/ClubsPage'));
const ClubDetailPage = lazy(() => import('./pages/ClubDetailPage'));
const ClubLobby = lazy(() => import('./pages/club/ClubLobby'));
const AgentPage = lazy(() => import('./pages/AgentPage'));
const TournamentPage = lazy(() => import('./pages/TournamentPage'));
const TournamentDetails = lazy(() => import('./pages/tournament/TournamentDetails'));
const TablePage = lazy(() => import('./pages/TablePage'));
const UnionsPage = lazy(() => import('./pages/UnionsPage'));
const UnionDetailPage = lazy(() => import('./pages/UnionDetailPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const HandReplay = lazy(() => import('./components/replay/HandReplay'));

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
    <TermsGate>
      <Suspense fallback={<Loader />}>
        <Routes>
          {/* Main Shell Routes */}
          <Route path="/" element={<Shell />}>
            <Route index element={<HomePage />} />
            <Route path="clubs" element={<ClubsPage />} />
            <Route path="clubs/:clubId" element={<ClubDetailPage />} />
            <Route path="clubs/:clubId/agents" element={<AgentPage />} />
            <Route path="clubs/:clubId/tournaments" element={<TournamentPage />} />
            <Route path="clubs/:clubId/tournaments/:tournamentId" element={<TournamentPage />} />
            <Route path="clubs/:clubId/table/:tableId" element={<TablePage />} />
            <Route path="play" element={<TablePage />} />
            <Route path="unions" element={<UnionsPage />} />
            <Route path="unions/:unionId" element={<UnionDetailPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          {/* PokerBros-style Club Routes (mobile-first, no shell) */}
          <Route path="club/:clubId" element={<ClubLobby />} />
          <Route path="club/:clubId/cash" element={<ClubLobby />} /> {/* Cash Games tab */}
          <Route path="club/:clubId/tournaments" element={<ClubLobby />} /> {/* Tournaments tab */}
          <Route path="club/:clubId/table/:tableId" element={<TablePage />} />
          <Route path="club/:clubId/tournament/:tournamentId" element={<TournamentDetails />} />

          {/* Hand Replay Route */}
          <Route path="replay/:handId" element={<HandReplay />} />
        </Routes>
      </Suspense>
    </TermsGate>
  );
}
