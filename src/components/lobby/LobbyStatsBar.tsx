/**
 * LobbyStatsBar — Club Arena Quick Metrics
 * Shows at-a-glance club vitals: Active Tables, Online Players, Total Pots.
 * Ported from Hub's LobbyStatsBar.jsx → TypeScript
 */

import React from 'react';

interface GameRow {
  status?: string;
  current_players?: number;
  registered_count?: number;
  player_count?: number;
  pot_total?: number;
  prize_pool?: number;
}

function StatPill({ icon, value, label }: { icon: string; value: number | string; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 20,
        border: '1px solid #3E4042',
      }}
    >
      <span style={{ fontSize: 14 }}>{icon}</span>
      <span
        style={{
          fontSize: 14,
          fontWeight: 800,
          color: '#F5A623',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 11, color: '#B0B3B8', fontWeight: 500 }}>{label}</span>
    </div>
  );
}

interface LobbyStatsBarProps {
  games?: GameRow[];
}

export default function LobbyStatsBar({ games = [] }: LobbyStatsBarProps) {
  const activeTables = games.filter((g) => g.status === 'active' || g.status === 'running').length;
  const totalPlayers = games.reduce(
    (sum, g) => sum + (g.current_players ?? g.registered_count ?? g.player_count ?? 0),
    0
  );
  const totalPots = games.reduce((sum, g) => sum + (g.pot_total ?? g.prize_pool ?? 0), 0);

  if (games.length === 0) return null;

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        padding: '8px 12px',
        overflowX: 'auto',
        scrollbarWidth: 'none',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      <StatPill icon="🎲" value={activeTables} label="Active" />
      <StatPill icon="👥" value={totalPlayers} label="Online" />
      {totalPots > 0 && (
        <StatPill
          icon="💰"
          value={totalPots >= 1000 ? `${(totalPots / 1000).toFixed(1)}K` : totalPots}
          label="In Pots"
        />
      )}
      <StatPill icon="🎯" value={games.length} label="Games" />
    </div>
  );
}
