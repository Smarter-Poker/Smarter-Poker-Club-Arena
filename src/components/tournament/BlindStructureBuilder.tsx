/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BLIND STRUCTURE BUILDER — Visual Drag-and-Drop Level Editor
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Full-featured blind structure editor for tournament creation:
 * - Preset templates (Turbo, Standard, Deep Stack)
 * - Add/remove/reorder blind levels
 * - Custom SB/BB/ante/duration per level
 * - Break insertion toggle
 * - Exports BlindLevel[] for tournament creation
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { BLIND_STRUCTURES } from '../../services/TournamentService';
import './BlindStructureBuilder.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface BlindLevel {
  level: number;
  smallBlind: number;
  bigBlind: number;
  ante: number;
  durationMinutes: number;
  isBreak?: boolean;
}

export type StructurePreset = 'turbo' | 'regular' | 'deepStack' | 'custom';

interface BlindStructureBuilderProps {
  initialStructure?: BlindLevel[];
  onChange: (levels: BlindLevel[]) => void;
  startingChips?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRESET DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

const BREAK_LEVEL: BlindLevel = {
  level: 0,
  smallBlind: 0,
  bigBlind: 0,
  ante: 0,
  durationMinutes: 5,
  isBreak: true,
};

const PRESET_LABELS: Record<StructurePreset, string> = {
  turbo: 'Turbo',
  regular: 'Standard',
  deepStack: 'Deep Stack',
  custom: '✏ Custom',
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const BlindStructureBuilder: React.FC<BlindStructureBuilderProps> = ({
  initialStructure,
  onChange,
  startingChips = 10000,
}) => {
  const [preset, setPreset] = useState<StructurePreset>(initialStructure ? 'custom' : 'regular');
  const [levels, setLevels] = useState<BlindLevel[]>(
    initialStructure || [...BLIND_STRUCTURES.regular]
  );
  const [breakEvery, setBreakEvery] = useState(6);
  const [autoInsertBreaks, setAutoInsertBreaks] = useState(true);

  // ── Preset Loading ──
  const loadPreset = useCallback((p: StructurePreset) => {
    setPreset(p);
    if (p === 'custom') return;

    const base =
      p === 'turbo'
        ? BLIND_STRUCTURES.turbo
        : p === 'deepStack'
          ? BLIND_STRUCTURES.deepStack
          : BLIND_STRUCTURES.regular;

    const newLevels = base.map((l, i) => ({ ...l, level: i + 1 }));
    setLevels(newLevels);
  }, []);

  // ── Level Mutations ──
  const updateLevel = useCallback(
    (index: number, field: keyof BlindLevel, value: number | boolean) => {
      setLevels((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], [field]: value };
        // Auto-set BB = 2x SB
        if (field === 'smallBlind') {
          updated[index].bigBlind = (value as number) * 2;
        }
        setPreset('custom');
        return updated;
      });
    },
    []
  );

  const addLevel = useCallback(() => {
    setLevels((prev) => {
      const lastLevel = prev.filter((l) => !l.isBreak).pop();
      const newLevel: BlindLevel = {
        level: prev.length + 1,
        smallBlind: lastLevel ? lastLevel.smallBlind * 2 : 50,
        bigBlind: lastLevel ? lastLevel.bigBlind * 2 : 100,
        ante: lastLevel ? Math.max(lastLevel.ante, lastLevel.bigBlind / 4) : 0,
        durationMinutes: lastLevel?.durationMinutes || 15,
      };
      const updated = [...prev, newLevel];
      setPreset('custom');
      return updated;
    });
  }, []);

  const removeLevel = useCallback((index: number) => {
    setLevels((prev) => {
      if (prev.length <= 3) return prev; // Minimum 3 levels
      const updated = prev.filter((_, i) => i !== index);
      // Renumber
      let levelNum = 1;
      const renumbered = updated.map((l) => {
        if (l.isBreak) return l;
        return { ...l, level: levelNum++ };
      });
      setPreset('custom');
      return renumbered;
    });
  }, []);

  const insertBreak = useCallback((afterIndex: number) => {
    setLevels((prev) => {
      const updated = [...prev];
      updated.splice(afterIndex + 1, 0, { ...BREAK_LEVEL });
      setPreset('custom');
      return updated;
    });
  }, []);

  const moveLevel = useCallback((fromIndex: number, direction: 'up' | 'down') => {
    setLevels((prev) => {
      const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= prev.length) return prev;
      const updated = [...prev];
      [updated[fromIndex], updated[toIndex]] = [updated[toIndex], updated[fromIndex]];
      // Renumber
      let levelNum = 1;
      const renumbered = updated.map((l) => {
        if (l.isBreak) return l;
        return { ...l, level: levelNum++ };
      });
      setPreset('custom');
      return renumbered;
    });
  }, []);

  // ── Auto-break insertion ──
  const levelsWithBreaks = useMemo(() => {
    if (!autoInsertBreaks) return levels;
    const result: BlindLevel[] = [];
    let playingCount = 0;
    for (const level of levels) {
      if (level.isBreak) {
        result.push(level);
        continue;
      }
      playingCount++;
      result.push(level);
      if (playingCount > 0 && playingCount % breakEvery === 0) {
        result.push({ ...BREAK_LEVEL });
      }
    }
    return result;
  }, [levels, autoInsertBreaks, breakEvery]);

  /**
   * AUDIT 2026-08-25: this component previewed one ladder and emitted another.
   * Auto-break insertion is ON by default, so the table, the level count and
   * the estimated duration all described `levelsWithBreaks`, while every
   * `onChange` call handed the parent the bare `levels` - a tournament built
   * here would silently have had no breaks in it at all. Nothing caught it
   * because nothing rendered the component.
   *
   * One effect on the derived value now, so what is shown is what is emitted,
   * and there is a single place where that can ever be true or false again.
   */
  useEffect(() => {
    onChange(levelsWithBreaks);
  }, [levelsWithBreaks, onChange]);

  // ── Stats ──
  const stats = useMemo(() => {
    const playLevels = levels.filter((l) => !l.isBreak);
    const totalMinutes = levelsWithBreaks.reduce((s, l) => s + l.durationMinutes, 0);
    const avgStack = startingChips;
    const lastSB = playLevels[playLevels.length - 1]?.smallBlind || 0;
    const lastBB = playLevels[playLevels.length - 1]?.bigBlind || 0;
    const startBBs = lastBB > 0 ? Math.round(avgStack / lastBB) : 0;
    return {
      playLevels: playLevels.length,
      totalMinutes,
      estimatedDuration: `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`,
      startingBBs: Math.round(startingChips / (playLevels[0]?.bigBlind || 1)),
      finalBBs: startBBs,
    };
  }, [levels, levelsWithBreaks, startingChips]);

  return (
    <div className="blind-structure-builder">
      {/* ── Preset Selector ── */}
      <div className="bsb-presets">
        {(Object.keys(PRESET_LABELS) as StructurePreset[]).map((p) => (
          <button
            type="button"
            key={p}
            className={`bsb-preset-btn ${preset === p ? 'active' : ''}`}
            onClick={() => loadPreset(p)}
          >
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>

      {/* ── Stats Bar ── */}
      <div className="bsb-stats">
        <div className="bsb-stat">
          <span className="bsb-stat-value">{stats.playLevels}</span>
          <span className="bsb-stat-label">Levels</span>
        </div>
        <div className="bsb-stat">
          <span className="bsb-stat-value">{stats.estimatedDuration}</span>
          <span className="bsb-stat-label">Est. Duration</span>
        </div>
        <div className="bsb-stat">
          <span className="bsb-stat-value">{stats.startingBBs} BB</span>
          <span className="bsb-stat-label">Starting Depth</span>
        </div>
      </div>

      {/* ── Break Settings ── */}
      <div className="bsb-break-settings">
        <label className="bsb-switch">
          <input
            type="checkbox"
            checked={autoInsertBreaks}
            onChange={(e) => setAutoInsertBreaks(e.target.checked)}
          />
          <span className="bsb-slider" />
          Auto-Insert Breaks Every
        </label>
        {autoInsertBreaks && (
          <select
            className="bsb-break-select"
            value={breakEvery}
            onChange={(e) => setBreakEvery(Number(e.target.value))}
          >
            <option value={4}>4 Levels</option>
            <option value={5}>5 Levels</option>
            <option value={6}>6 Levels</option>
            <option value={8}>8 Levels</option>
          </select>
        )}
      </div>

      {/* ── Level Table ── */}
      <div className="bsb-table-wrapper">
        <table className="bsb-table">
          <thead>
            <tr>
              <th className="bsb-col-level">#</th>
              <th className="bsb-col-sb">SB</th>
              <th className="bsb-col-bb">BB</th>
              <th className="bsb-col-ante">Ante</th>
              <th className="bsb-col-duration">Duration</th>
              <th className="bsb-col-actions">Actions</th>
            </tr>
          </thead>
          <tbody>
            {levels.map((level, index) => (
              <tr key={index} className={`bsb-row ${level.isBreak ? 'bsb-break-row' : ''}`}>
                {level.isBreak ? (
                  <>
                    <td colSpan={4} className="bsb-break-label">
                      BREAK
                    </td>
                    <td className="bsb-col-duration">
                      <input
                        type="number"
                        className="bsb-input"
                        value={level.durationMinutes}
                        onChange={(e) =>
                          updateLevel(index, 'durationMinutes', Number(e.target.value))
                        }
                        min={1}
                        max={30}
                      />
                      <span className="bsb-unit">Min</span>
                    </td>
                    <td className="bsb-col-actions">
                      <button
                        type="button"
                        className="bsb-btn-remove"
                        onClick={() => removeLevel(index)}
                        title="Remove Break"
                      >
                        ✕
                      </button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="bsb-col-level">{level.level}</td>
                    <td className="bsb-col-sb">
                      <input
                        type="number"
                        className="bsb-input"
                        value={level.smallBlind}
                        onChange={(e) => updateLevel(index, 'smallBlind', Number(e.target.value))}
                        min={1}
                      />
                    </td>
                    <td className="bsb-col-bb">
                      <input
                        type="number"
                        className="bsb-input"
                        value={level.bigBlind}
                        onChange={(e) => updateLevel(index, 'bigBlind', Number(e.target.value))}
                        min={2}
                      />
                    </td>
                    <td className="bsb-col-ante">
                      <input
                        type="number"
                        className="bsb-input"
                        value={level.ante}
                        onChange={(e) => updateLevel(index, 'ante', Number(e.target.value))}
                        min={0}
                      />
                    </td>
                    <td className="bsb-col-duration">
                      <input
                        type="number"
                        className="bsb-input"
                        value={level.durationMinutes}
                        onChange={(e) =>
                          updateLevel(index, 'durationMinutes', Number(e.target.value))
                        }
                        min={1}
                        max={120}
                      />
                      <span className="bsb-unit">Min</span>
                    </td>
                    <td className="bsb-col-actions">
                      <div className="bsb-action-group">
                        <button
                          type="button"
                          className="bsb-btn-move"
                          onClick={() => moveLevel(index, 'up')}
                          disabled={index === 0}
                          title="Move Up"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="bsb-btn-move"
                          onClick={() => moveLevel(index, 'down')}
                          disabled={index === levels.length - 1}
                          title="Move Down"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="bsb-btn-break"
                          onClick={() => insertBreak(index)}
                          title="Insert Break After"
                        >
                          ◇
                        </button>
                        <button
                          type="button"
                          className="bsb-btn-remove"
                          onClick={() => removeLevel(index)}
                          title="Remove Level"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Add Level Button ── */}
      <button type="button" className="bsb-add-level" onClick={addLevel}>
        + Add Level
      </button>
    </div>
  );
};

export default BlindStructureBuilder;
