/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MISSIONS PANEL — Tiered daily/weekly/monthly mission cards
 * ═══════════════════════════════════════════════════════════════════════════════
 * Progress bars, XP + diamond reward badges, completion animation.
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import { triggerHaptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';
import './MissionsPanel.css';

type MissionTier = 'daily' | 'weekly' | 'monthly';

interface Mission {
  id: string;
  tier: MissionTier;
  title: string;
  description: string;
  icon: string;
  current: number;
  target: number;
  rewardAmount: number;
  rewardType: 'xp' | 'diamonds' | 'chips';
  completed: boolean;
  claimed: boolean;
}

interface MissionsPanelProps {
  missions: Mission[];
  onClaim: (missionId: string) => void;
}

const TIER_CONFIG: Record<MissionTier, { label: string; icon: string; color: string }> = {
  daily: { label: 'Daily', icon: '📅', color: '#00d4ff' },
  weekly: { label: 'Weekly', icon: '📆', color: '#ffa726' },
  monthly: { label: 'Monthly', icon: '🗓️', color: '#c084fc' },
};

const REWARD_ICONS: Record<string, string> = {
  xp: '⭐',
  diamonds: '💎',
  chips: '🪙',
};

export default function MissionsPanel({ missions, onClaim }: MissionsPanelProps) {
  const [activeTier, setActiveTier] = useState<MissionTier>('daily');
  const [celebratingIds, setCelebratingIds] = useState<string[]>([]);
  const celebrateTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      celebrateTimers.current.forEach(clearTimeout);
    };
  }, []);

  const filtered = useMemo(
    () => missions.filter((m) => m.tier === activeTier),
    [missions, activeTier]
  );

  const tierCounts = useMemo(() => {
    const counts: Record<MissionTier, { total: number; done: number }> = {
      daily: { total: 0, done: 0 },
      weekly: { total: 0, done: 0 },
      monthly: { total: 0, done: 0 },
    };
    missions.forEach((m) => {
      counts[m.tier].total++;
      if (m.completed) counts[m.tier].done++;
    });
    return counts;
  }, [missions]);

  return (
    <div className="missions-panel">
      {/* Tier Tabs */}
      <div className="mp-tabs">
        {(Object.keys(TIER_CONFIG) as MissionTier[]).map((tier) => {
          const cfg = TIER_CONFIG[tier];
          const count = tierCounts[tier];
          return (
            <button
              key={tier}
              className={`mp-tab ${activeTier === tier ? 'active' : ''}`}
              onClick={() => setActiveTier(tier)}
              style={{ '--tab-color': cfg.color } as React.CSSProperties}
            >
              <span className="mp-tab-icon">{cfg.icon}</span>
              <span className="mp-tab-label">{cfg.label}</span>
              <span className="mp-tab-progress">
                {count.done}/{count.total}
              </span>
            </button>
          );
        })}
      </div>

      {/* Mission Cards */}
      <div className="mp-list">
        {filtered.length === 0 ? (
          <div className="mp-empty">
            <span className="mp-empty-icon">🎯</span>
            <span className="mp-empty-text">No missions available</span>
          </div>
        ) : (
          filtered.map((mission) => {
            const progress = mission.target > 0 ? Math.min(mission.current / mission.target, 1) : 0;
            const rewardIcon = REWARD_ICONS[mission.rewardType] || '⭐';
            return (
              <div
                key={mission.id}
                className={`mp-card ${mission.completed ? 'complete' : ''} ${mission.claimed ? 'claimed' : ''} ${celebratingIds.includes(mission.id) ? 'mp-celebrate' : ''}`}
              >
                <div className="mp-card-icon">{mission.icon}</div>

                <div className="mp-card-content">
                  <span className="mp-card-title">{mission.title}</span>
                  <span className="mp-card-desc">{mission.description}</span>

                  {/* Progress bar */}
                  <div className="mp-progress">
                    <div
                      className="mp-progress-fill"
                      style={{
                        width: `${progress * 100}%`,
                        background: TIER_CONFIG[mission.tier].color,
                      }}
                    />
                    <span className="mp-progress-text">
                      {mission.current}/{mission.target}
                    </span>
                  </div>
                </div>

                {/* Reward / Claim */}
                <div className="mp-card-reward">
                  {mission.claimed ? (
                    <span className="mp-claimed-badge">✅</span>
                  ) : mission.completed ? (
                    <button
                      className="mp-claim-btn"
                      onClick={() => {
                        triggerHaptic('success');
                        setCelebratingIds((prev) => [...prev, mission.id]);
                        const t = setTimeout(() => {
                          setCelebratingIds((prev) => prev.filter((id) => id !== mission.id));
                        }, 1500);
                        celebrateTimers.current.push(t);

                        masterBus.emit('MISSION_CLAIMED', {
                          missionId: mission.id,
                          tier: mission.tier,
                          rewardType: mission.rewardType,
                          rewardAmount: mission.rewardAmount,
                        });
                        onClaim(mission.id);
                      }}
                    >
                      Claim
                    </button>
                  ) : (
                    <span className="mp-reward-badge">
                      {rewardIcon} {mission.rewardAmount}
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export type { Mission, MissionTier };
