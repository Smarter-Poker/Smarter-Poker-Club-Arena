import React, { useState, useEffect, useRef } from 'react';
import { unionService } from '../../services';
import { useToast } from '../common/Toast';
import './RevenueSplitEditor.css';

interface ClubSplit {
  clubId: string;
  clubName: string;
  clubLogo?: string;
  splitPercentage: number;
  volume30d: number;
}

interface RevenueSplitEditorProps {
  unionId: string;
  clubs: ClubSplit[];
  defaultSplit: number;
  onUpdate?: () => void;
}

export const RevenueSplitEditor: React.FC<RevenueSplitEditorProps> = ({
  unionId,
  clubs,
  defaultSplit,
  onUpdate,
}) => {
  const { showToast } = useToast();
  const [splits, setSplits] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    clubs.forEach((c) => {
      initial[c.clubId] = c.splitPercentage;
    });
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
    };
  }, []);

  useEffect(() => {
    staggerTimersRef.current.forEach((t) => clearTimeout(t));
    staggerTimersRef.current = clubs.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [clubs]);

  const handleSplitChange = (clubId: string, value: number) => {
    setSplits((prev) => ({
      ...prev,
      [clubId]: Math.min(100, Math.max(0, value)),
    }));
  };

  const handleApplyDefault = () => {
    const newSplits: Record<string, number> = {};
    clubs.forEach((c) => {
      newSplits[c.clubId] = defaultSplit;
    });
    setSplits(newSplits);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await unionService.updateClubSplits(unionId, splits);
      showToast('Revenue splits updated', 'success');
      onUpdate?.();
    } catch (error) {
      showToast('Failed to update splits', 'error');
    } finally {
      setSaving(false);
    }
  };

  const totalVolume = clubs.reduce((sum, c) => sum + c.volume30d, 0);

  return (
    <div className="revenue-split-editor">
      <div className="editor-header">
        <h3>Revenue Split by Club</h3>
        <button className="apply-default-btn" onClick={handleApplyDefault}>
          Apply Default ({defaultSplit}%)
        </button>
      </div>

      <div className="split-list">
        {clubs.map((club, i) => (
          <div
            key={club.clubId}
            className="split-row"
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div className="club-info">
              <div className="club-logo">
                {club.clubLogo ? (
                  <img loading="lazy" decoding="async" src={club.clubLogo} alt={club.clubName} />
                ) : (
                  <span>{club.clubName[0]}</span>
                )}
              </div>
              <div className="club-details">
                <div className="club-name">{club.clubName}</div>
                <div className="club-volume">30d Volume: {club.volume30d.toLocaleString()}</div>
              </div>
            </div>

            <div className="split-control">
              <input
                type="range"
                min={0}
                max={100}
                value={splits[club.clubId] || 0}
                onChange={(e) => handleSplitChange(club.clubId, Number(e.target.value))}
              />
              <div className="split-value">
                <input
                  type="number"
                  value={splits[club.clubId] || 0}
                  onChange={(e) => handleSplitChange(club.clubId, Number(e.target.value))}
                  min={0}
                  max={100}
                />
                <span>%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="editor-footer">
        <div className="total-stat">
          <span className="stat-label">Total Volume (30d)</span>
          <span className="stat-value">{totalVolume.toLocaleString()}</span>
        </div>
        <button className="save-splits-btn" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

export default RevenueSplitEditor;
