/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER PROFILE CARD — Compact Profile Display
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect } from 'react';
import { supabase } from '../../lib/supabase';
import './PlayerProfileCard.css';
import { reportError } from '../../utils/errorReporter';

interface PlayerProfileCardProps {
  userId: string;
  onMessage?: () => void;
  onAddNote?: () => void;
  onInvite?: () => void;
  compact?: boolean;
}

interface PlayerProfile {
  id: string;
  username: string;
  avatarUrl: string;
  level: number;

  isVIP: boolean;
  status: 'online' | 'away' | 'offline' | 'playing';
  stats: {
    handsPlayed: number;
    vpip: number;
    pfr: number;
    winRate: number;
  };
  currentTable?: string;
}

export function PlayerProfileCard({
  userId,
  onMessage,
  onAddNote,
  onInvite,
  compact = false,
}: PlayerProfileCardProps) {
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (!loading && profile) {
      // BUG FIX (mount-timer): track timer so it cancels on unmount — prevents stale setState
      const _mountTimer = setTimeout(() => setMounted(true), 50);
      return () => clearTimeout(_mountTimer);
    }
  }, [loading, profile]);

  useEffect(() => {
    loadProfile();
  }, [userId]);

  const loadProfile = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*, player_stats(*)')
        .eq('id', userId)
        .maybeSingle();

      if (!error && data) {
        const stats = Array.isArray(data.player_stats) ? data.player_stats[0] : data.player_stats;
        setProfile({
          id: data.id,
          username: data.username || 'Unknown',
          avatarUrl: data.avatar_url || '',
          level: data.level || 1,

          isVIP: data.is_vip || false,
          status: data.is_online ? 'online' : 'offline',
          stats: {
            handsPlayed: stats?.hands_played || 0,
            vpip: stats?.vpip || 0,
            pfr: stats?.pfr || 0,
            winRate: stats?.win_rate || 0,
          },
          currentTable: undefined,
        });
      }
    } catch (error) {
      reportError(error, 'PlayerProfileCard.Failed_to_load_profile');
    }
    setLoading(false);
  };

  if (loading) {
    return <div className="player-profile-card__player-card loading">Loading...</div>;
  }

  if (!profile) {
    return <div className="player-profile-card__player-card error">Player Not Found</div>;
  }

  return (
    <div
      className={`player-profile-card__player-card ${compact ? 'compact' : ''}`}
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
      }}
    >
      <div className="player-card__header">
        <div className={`status-indicator ${profile.status}`} />
        <span className="avatar">{profile.avatarUrl}</span>
        <div className="info">
          <span className="username">
            {profile.username}
            {profile.isVIP && <span className="vip-badge"></span>}
          </span>
          <span className="level">Level {profile.level}</span>
        </div>
      </div>

      {!compact && (
        <>
          <div className="player-card__stats">
            <div className="stat">
              <span className="value">{profile.stats.handsPlayed.toLocaleString()}</span>
              <span className="label">Hands</span>
            </div>
            <div className="stat">
              <span className="value">{profile.stats.vpip}%</span>
              <span className="label">VPIP</span>
            </div>
            <div className="stat">
              <span className="value">{profile.stats.pfr}%</span>
              <span className="label">PFR</span>
            </div>
            <div className="stat">
              <span className={`value ${profile.stats.winRate >= 0 ? 'positive' : 'negative'}`}>
                {profile.stats.winRate >= 0 ? '+' : ''}
                {profile.stats.winRate}
              </span>
              <span className="label">BB/100</span>
            </div>
          </div>

          {profile.currentTable && (
            <div className="player-card__current">
              Playing At <strong>{profile.currentTable}</strong>
            </div>
          )}

          <div className="player-card__actions">
            {onMessage && <button onClick={onMessage}> Message</button>}
            {onAddNote && <button onClick={onAddNote}> Note</button>}
            {onInvite && <button onClick={onInvite}>Invite</button>}
          </div>
        </>
      )}
    </div>
  );
}

export default PlayerProfileCard;
