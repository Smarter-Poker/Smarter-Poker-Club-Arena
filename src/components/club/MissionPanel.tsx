/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MISSION PANEL — Daily Challenges
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Daily and Weekly missions for players.
 * - Progress bars
 * - Claimable rewards
 * - Timer until reset
 */

import React, { useState, useEffect, useRef } from 'react';
import './MissionPanel.css';

export interface Mission {
  id: string;
  title: string;
  description: string;
  current: number;
  target: number;
  reward: number; // Chips or Diamonds
  isClaimed: boolean;
  type: 'daily' | 'weekly';
}

export interface MissionPanelProps {
  isOpen: boolean;
  onClose: () => void;
  missions: Mission[];
  onClaim: (missionId: string) => void;
}

export function MissionPanel({ isOpen, onClose, missions, onClaim }: MissionPanelProps) {
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = missions.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    }
  }, [missions, isOpen]);

  if (!isOpen) return null;

  const dailies = missions.filter((m) => m.type === 'daily');
  const weeklies = missions.filter((m) => m.type === 'weekly');

  return (
    <div className="mission-overlay" onClick={onClose}>
      <div className="mission-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="mission-header">
          <div className="mission-title-group">
            <span className="mission-icon"></span>
            <div>
              <h2 className="mission-title">Missions & Rewards</h2>
              <span className="mission-subtitle">Complete Tasks To Earn Bonuses!</span>
            </div>
          </div>
          <button className="mission-close" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Content */}
        <div className="mission-content">
          {/* Dailies */}
          {dailies.length > 0 && (
            <div className="mission-section">
              <h3 className="section-header">
                Daily Missions <span className="timer">Resets In 4H 12M</span>
              </h3>
              <div className="mission-list">
                {dailies.map((m, i) => (
                  <div
                    key={m.id}
                    style={{
                      opacity: visibleItems.has(i) ? 1 : 0,
                      transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <MissionItem mission={m} onClaim={onClaim} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Weeklies */}
          {weeklies.length > 0 && (
            <div className="mission-section">
              <h3 className="section-header">
                Weekly Challenges <span className="timer">Resets In 3D</span>
              </h3>
              <div className="mission-list">
                {weeklies.map((m, i) => (
                  <div
                    key={m.id}
                    style={{
                      opacity: visibleItems.has(dailies.length + i) ? 1 : 0,
                      transform: visibleItems.has(dailies.length + i)
                        ? 'translateY(0)'
                        : 'translateY(8px)',
                      transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
                    }}
                  >
                    <MissionItem mission={m} onClaim={onClaim} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MissionItem({ mission, onClaim }: { mission: Mission; onClaim: (id: string) => void }) {
  const percent = mission.target > 0 ? Math.min(100, (mission.current / mission.target) * 100) : 0;
  const isCompleted = mission.current >= mission.target;

  return (
    <div className={`mission-card ${isCompleted ? 'completed' : ''}`}>
      <div className="mission-info">
        <h4 className="mission-name">{mission.title}</h4>
        <p className="mission-desc">{mission.description}</p>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="progress-text">
          {mission.current} / {mission.target}
        </div>
      </div>

      <div className="mission-action">
        <div className="reward-badge"> {mission.reward}</div>
        <button
          className={`claim-btn ${isCompleted ? 'ready' : ''} ${mission.isClaimed ? 'claimed' : ''}`}
          disabled={!isCompleted || mission.isClaimed}
          onClick={() => onClaim(mission.id)}
        >
          {mission.isClaimed ? 'Claimed' : isCompleted ? 'Claim' : 'Active'}
        </button>
      </div>
    </div>
  );
}

export default MissionPanel;
