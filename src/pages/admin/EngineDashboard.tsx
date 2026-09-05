import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  getCashStats,
  getTournamentStats,
  refreshCashStats,
  refreshTournamentStats,
  type CashEngineStats,
  type TournamentEngineStats,
} from '../../services/AdminStatsService';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../../components/common/Toast';
import { SettlementCronStatus } from '../../components/SettlementCronStatus';
import './EngineDashboard.css';

export default function EngineDashboard() {
  const [stats, setStats] = useState<CashEngineStats>(getCashStats());
  const [tStats, setTStats] = useState<TournamentEngineStats>(getTournamentStats());
  const [hydraStats, setHydraStats] = useState({ available: 0, seated: 0 });
  const toast = useToast();

  // Initial + polled refresh of engine stats from Supabase. (Phase U2 Stage B:
  // replaces client-side cashGameOrchestrator/tournamentOrchestrator singletons.)
  useEffect(() => {
    const refresh = async () => {
      const [cash, tour] = await Promise.all([refreshCashStats(), refreshTournamentStats()]);
      setStats(cash);
      setTStats(tour);
    };
    refresh();
    const interval = setInterval(refresh, 5000); // 5s — durable reads; no need for 1s
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    loadHydraStats();
    const interval = setInterval(loadHydraStats, 10000); // 10s refresh for Hydra
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsubTable = masterBus.subscribeDebounced(
      'TABLE_UPDATED',
      async () => {
        setStats(await refreshCashStats());
        loadHydraStats();
      },
      500
    );
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      async () => {
        setStats(await refreshCashStats());
      },
      500
    );
    const unsubTournament = masterBus.subscribeDebounced(
      'TOURNAMENT_UPDATED',
      async () => {
        setTStats(await refreshTournamentStats());
      },
      500
    );
    // Phase 3: Refresh Hydra stats when horses are seated or removed
    const unsubHorseSeated = masterBus.subscribeDebounced(
      'HORSE_SEATED',
      () => {
        loadHydraStats();
      },
      500
    );
    const unsubHorseRemoved = masterBus.subscribeDebounced(
      'HORSE_REMOVED',
      () => {
        loadHydraStats();
      },
      500
    );
    // TABLE_BREAK_COMPLETED listener removed 2026-08-28: the server emits it
    // only on the engine channel; it is never relayed onto the client bus, so
    // this refresh never fired. Revive via a relay if wanted.
    // Phase 4: Refresh stats on bomb pot triggers (cash game activity)
    const unsubBombPot = masterBus.subscribeDebounced(
      'BOMB_POT_TRIGGERED',
      async () => {
        setStats(await refreshCashStats());
      },
      500
    );
    return () => {
      unsubTable();
      unsubHand();
      unsubTournament();
      unsubHorseSeated();
      unsubHorseRemoved();
      unsubBombPot();
    };
  }, []);

  const loadHydraStats = async () => {
    const { data: available, error: err1 } = await supabase
      .from('profiles')
      .select('id', { count: 'exact' })
      .eq('is_horse', true)
      .eq('horse_status', 'available');

    const { data: seated, error: err2 } = await supabase
      .from('profiles')
      .select('id', { count: 'exact' })
      .eq('is_horse', true)
      .eq('horse_status', 'seated');

    if (!err1 && !err2) {
      setHydraStats({
        available: available?.length || 0,
        seated: seated?.length || 0,
      });
    }
  };

  // Engine lifecycle is managed by Hetzner (`club-arena-engine` container via
  // SSH/systemd). These handlers warn the operator and no-op; a separate admin
  // flow can call POST https://engine.smarter.poker/admin/pause|/admin/resume.
  const handleToggleOrchestrator = async () => {
    toast.info('Engine is managed by the Hetzner container. Use SSH or the /admin/pause endpoint.');
  };

  const handleToggleTournament = async () => {
    toast.info('Tournament engine runs on Hetzner. Use SSH or the /admin/pause endpoint to halt.');
  };

  return (
    <div className="engine-dashboard">
      <header className="engine-header">
        <h1>⚙ Global Matrix Orchestrator</h1>
        <p>Master Control Panel For The Club Arena Cash Game & Hydra Engines</p>
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <Link
            to="/analytics"
            style={{
              padding: '6px 16px',
              borderRadius: 8,
              background: 'rgba(59, 130, 246, 0.15)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              color: '#3b82f6',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Analytics Dashboard
          </Link>
        </div>
      </header>

      {/* ── Settlement Cron Status ─────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        <SettlementCronStatus />
      </div>

      <div className="engine-grid">
        <div className="engine-card">
          <div className="card-header">
            <h3>Cash Game Master Engine</h3>
            <span
              className={`engine-dashboard__status-badge ${stats.running ? 'online' : 'offline'}`}
            >
              {stats.running ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
          <p className="card-desc">
            Controls All HeadlessTableEngine Instances Globally. When Online, Active Tables Will
            Automatically Deal Hands.
          </p>
          <div className="card-metrics">
            <div className="metric">
              <span className="label">Active Tables</span>
              <span className="value">{stats.activeTables}</span>
            </div>
            <div className="metric">
              <span className="label">Total Hands Dealt</span>
              <span className="value">{stats.totalHandsDealt.toLocaleString()}</span>
            </div>
          </div>
          <button
            className={`engine-btn ${stats.running ? 'btn-stop' : 'btn-start'}`}
            onClick={handleToggleOrchestrator}
          >
            {stats.running ? 'SHUTDOWN ENGINE' : 'IGNITE ENGINE'}
          </button>
        </div>

        <div className="engine-card">
          <div className="card-header">
            <h3>Hydra Fleet Command</h3>
            <span
              className={`engine-dashboard__status-badge ${stats.running ? 'online' : 'offline'}`}
            >
              {stats.running ? 'ACTIVE' : 'IDLE'}
            </span>
          </div>
          <p className="card-desc">
            Manages The 300+ Horse Liquidity Fleet. Automatically Seeds Empty Tables And Organically
            Recedes When Real Players Join.
          </p>
          <div className="card-metrics">
            <div className="metric">
              <span className="label">Available Horses</span>
              <span className="value">{hydraStats.available}</span>
            </div>
            <div className="metric">
              <span className="label">Seated Horses</span>
              <span className="value text-green">{hydraStats.seated}</span>
            </div>
          </div>
          <div className="card-metrics" style={{ marginTop: 8 }}>
            <div className="metric">
              <span className="label">3-Player Min</span>
              <span className="value text-green">ENFORCING</span>
            </div>
            <div className="metric">
              <span className="label">Persona Rotation</span>
              <span className="value text-green">30M CYCLE</span>
            </div>
          </div>
          <button className="engine-btn btn-secondary" disabled>
            Hydra Is Linked To Master Engine
          </button>
        </div>

        <div className="engine-card">
          <div className="card-header">
            <h3>Tournament Director</h3>
            <span
              className={`engine-dashboard__status-badge ${tStats.running ? 'online' : 'offline'}`}
            >
              {tStats.running ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
          <p className="card-desc">
            Controls All TournamentEngine Instances Globally. When Online, Tournaments Will
            Automatically Start, Break Tables, And Process Payouts.
          </p>
          <div className="card-metrics">
            <div className="metric">
              <span className="label">Active Tourneys</span>
              <span className="value">{tStats.activeTournaments}</span>
            </div>
            <div className="metric">
              <span className="label">Total Players</span>
              <span className="value">{tStats.totalPlayers.toLocaleString()}</span>
            </div>
          </div>
          <button
            className={`engine-btn ${tStats.running ? 'btn-stop' : 'btn-start'}`}
            onClick={handleToggleTournament}
          >
            {tStats.running ? 'SHUTDOWN DIRECTOR' : 'START DIRECTOR'}
          </button>
        </div>
      </div>
    </div>
  );
}
