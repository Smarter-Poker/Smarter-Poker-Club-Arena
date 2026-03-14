import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { cashGameOrchestrator } from '../../engine/CashGameOrchestrator';
import { tournamentOrchestrator } from '../../engine/TournamentOrchestrator';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { useToast } from '../../components/common/Toast';
import { SettlementCronStatus } from '../../components/SettlementCronStatus';
import './EngineDashboard.css';

export default function EngineDashboard() {
  const [stats, setStats] = useState(cashGameOrchestrator.getStats());
  const [tStats, setTStats] = useState(tournamentOrchestrator.getStats());
  const [hydraStats, setHydraStats] = useState({ available: 0, seated: 0 });
  const toast = useToast();

  useEffect(() => {
    // Refresh stats every second
    const interval = setInterval(() => {
      setStats(cashGameOrchestrator.getStats());
      setTStats(tournamentOrchestrator.getStats());
    }, 1000);
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
      () => {
        setStats(cashGameOrchestrator.getStats());
        loadHydraStats();
      },
      500
    );
    const unsubHand = masterBus.subscribeDebounced(
      'HAND_COMPLETED',
      () => {
        setStats(cashGameOrchestrator.getStats());
      },
      500
    );
    const unsubTournament = masterBus.subscribeDebounced(
      'TOURNAMENT_UPDATED',
      () => {
        setTStats(tournamentOrchestrator.getStats());
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
    // Phase 4: Refresh stats on table break completions (tournament rebalancing)
    const unsubTableBreak = masterBus.subscribeDebounced(
      'TABLE_BREAK_COMPLETED',
      () => {
        setTStats(tournamentOrchestrator.getStats());
      },
      500
    );
    // Phase 4: Refresh stats on bomb pot triggers (cash game activity)
    const unsubBombPot = masterBus.subscribeDebounced(
      'BOMB_POT_TRIGGERED',
      () => {
        setStats(cashGameOrchestrator.getStats());
      },
      500
    );
    return () => {
      unsubTable();
      unsubHand();
      unsubTournament();
      unsubHorseSeated();
      unsubHorseRemoved();
      unsubTableBreak();
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

  const handleToggleOrchestrator = async () => {
    try {
      if (stats.running) {
        await cashGameOrchestrator.stop();
        toast.info('Cash Game Orchestrator stopped. All tables halted.');
      } else {
        await cashGameOrchestrator.start();
        toast.success('Cash Game Orchestrator started! Engines spinning up.');
      }
      setStats(cashGameOrchestrator.getStats());
    } catch (err) {
      toast.error('Failed to toggle orchestrator');
    }
  };

  const handleToggleTournament = async () => {
    try {
      if (tStats.running) {
        await tournamentOrchestrator.stop();
        toast.info('Tournament Orchestrator stopped. All tournaments paused.');
      } else {
        await tournamentOrchestrator.start();
        toast.success('Tournament Orchestrator started!');
      }
      setTStats(tournamentOrchestrator.getStats());
    } catch (err) {
      toast.error('Failed to toggle tournament orchestrator');
    }
  };

  return (
    <div className="engine-dashboard">
      <header className="engine-header">
        <h1>⚙️ Global Matrix Orchestrator</h1>
        <p>Master Control Panel for the Club Arena Cash Game & Hydra Engines</p>
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
            📊 Analytics Dashboard
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
            <span className={`status-badge ${stats.running ? 'online' : 'offline'}`}>
              {stats.running ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
          <p className="card-desc">
            Controls all HeadlessTableEngine instances globally. When online, active tables will
            automatically deal hands.
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
            <span className={`status-badge ${stats.running ? 'online' : 'offline'}`}>
              {stats.running ? 'ACTIVE' : 'IDLE'}
            </span>
          </div>
          <p className="card-desc">
            Manages the 300+ Horse liquidity fleet. Automatically seeds empty tables and organically
            recedes when real players join.
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
              <span className="value text-green">30m CYCLE</span>
            </div>
          </div>
          <button className="engine-btn btn-secondary" disabled>
            Hydra is linked to Master Engine
          </button>
        </div>

        <div className="engine-card">
          <div className="card-header">
            <h3>Tournament Director</h3>
            <span className={`status-badge ${tStats.running ? 'online' : 'offline'}`}>
              {tStats.running ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
          <p className="card-desc">
            Controls all TournamentEngine instances globally. When online, tournaments will
            automatically start, break tables, and process payouts.
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
