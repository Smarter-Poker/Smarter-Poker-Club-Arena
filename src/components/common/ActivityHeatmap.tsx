/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ActivityHeatmap — GitHub-Style Contribution Heatmap
 *  Renders a 7×N grid (weeks/days) with intensity-based coloring
 *  Fully responsive, tooltip on hover, configurable colors
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useMemo, useState } from 'react';

interface HeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
}

interface ActivityHeatmapProps {
  data: HeatmapDay[];
  label?: string;
  colorScheme?: 'cyan' | 'green' | 'purple';
  weeks?: number; // how many weeks to show (default 12)
}

const COLOR_SCHEMES = {
  cyan: [
    'rgba(0,212,255,0.05)',
    'rgba(0,212,255,0.2)',
    'rgba(0,212,255,0.4)',
    'rgba(0,212,255,0.6)',
    'rgba(0,212,255,0.85)',
  ],
  green: [
    'rgba(16,185,129,0.05)',
    'rgba(16,185,129,0.2)',
    'rgba(16,185,129,0.4)',
    'rgba(16,185,129,0.6)',
    'rgba(16,185,129,0.85)',
  ],
  purple: [
    'rgba(139,92,246,0.05)',
    'rgba(139,92,246,0.2)',
    'rgba(139,92,246,0.4)',
    'rgba(139,92,246,0.6)',
    'rgba(139,92,246,0.85)',
  ],
};

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

export default function ActivityHeatmap({
  data,
  label = 'Activity',
  colorScheme = 'cyan',
  weeks = 12,
}: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);

  /** One readout, reachable by pointer, tap or keyboard. */
  const showCell = (el: HTMLElement, cell: { date: string; count: number } | undefined) => {
    if (!cell) return;
    const rect = el.getBoundingClientRect();
    setTooltip({
      x: rect.left + rect.width / 2,
      y: rect.top - 10,
      text: `${cell.count} action${cell.count !== 1 ? 's' : ''} on ${cell.date}`,
    });
  };

  const { grid, maxCount, totalCount } = useMemo(() => {
    const lookup = new Map(data.map((d) => [d.date, d.count]));
    const totalDays = weeks * 7;
    const today = new Date();
    const cells: { date: string; count: number; day: number; week: number }[] = [];
    let max = 0;
    let total = 0;

    for (let i = totalDays - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const count = lookup.get(key) || 0;
      max = Math.max(max, count);
      total += count;
      const dayOfWeek = d.getDay(); // 0=Sun
      const weekIdx = Math.floor((totalDays - 1 - i) / 7);
      cells.push({ date: key, count, day: dayOfWeek, week: weekIdx });
    }

    return { grid: cells, maxCount: max, totalCount: total };
  }, [data, weeks]);

  const colors = COLOR_SCHEMES[colorScheme];

  const getColor = (count: number) => {
    if (count === 0) return colors[0];
    if (maxCount === 0) return colors[0];
    const ratio = count / maxCount;
    if (ratio < 0.25) return colors[1];
    if (ratio < 0.5) return colors[2];
    if (ratio < 0.75) return colors[3];
    return colors[4];
  };

  const cellSize = 14;
  const gap = 3;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span
          style={{
            color: '#00d4ff',
            fontSize: '0.8rem',
            fontFamily: "'Rajdhani', monospace",
            textTransform: 'uppercase',
            letterSpacing: '1px',
          }}
        >
          {label}
        </span>
        <span style={{ color: '#6a7a8a', fontSize: '0.7rem' }}>
          {totalCount.toLocaleString()} Total · Last {weeks} Weeks
        </span>
      </div>

      {/* Grid */}
      <div
        style={{ position: 'relative', display: 'flex', gap: '2px', overflow: 'hidden' }}
        onMouseLeave={() => setTooltip(null)}
      >
        {/* Day labels */}
        <div
          style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px`, marginRight: '4px' }}
        >
          {DAY_LABELS.map((d, i) => (
            <div
              key={i}
              style={{
                width: 20,
                height: cellSize,
                fontSize: '0.55rem',
                color: '#6a7a8a',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'flex-end',
              }}
            >
              {d}
            </div>
          ))}
        </div>

        {/* Weeks columns */}
        {Array.from({ length: weeks }, (_, weekIdx) => (
          <div key={weekIdx} style={{ display: 'flex', flexDirection: 'column', gap: `${gap}px` }}>
            {Array.from({ length: 7 }, (_, dayIdx) => {
              const cell = grid.find((c) => c.week === weekIdx && c.day === dayIdx);
              return (
                <div
                  key={dayIdx}
                  style={{
                    width: cellSize,
                    height: cellSize,
                    borderRadius: 3,
                    background: cell ? getColor(cell.count) : colors[0],
                    border: '1px solid rgba(255,255,255,0.04)',
                    cursor: cell ? 'pointer' : 'default',
                    transition: 'transform 0.1s ease',
                  }}
                  /**
                   * TAP AND KEYBOARD REACH THE READOUT TOO (2026-08-29).
                   *
                   * The count and the date lived only in a `mouseenter`
                   * handler, so on a phone — which is where Club Arena is
                   * mostly used — this grid was a wall of coloured squares
                   * with no way to learn what any of them meant. Same for
                   * anyone navigating by keyboard.
                   *
                   * One handler, four events. Focus is genuine here because
                   * the cell is now focusable; the label is the same sentence
                   * the tooltip shows, so a screen reader gets it without
                   * needing the tooltip to open at all.
                   */
                  tabIndex={cell ? 0 : -1}
                  role={cell ? 'button' : undefined}
                  aria-label={
                    cell
                      ? `${cell.count} Action${cell.count !== 1 ? 's' : ''} On ${cell.date}`
                      : undefined
                  }
                  onMouseEnter={(e) => showCell(e.currentTarget, cell)}
                  onFocus={(e) => showCell(e.currentTarget, cell)}
                  onClick={(e) => showCell(e.currentTarget, cell)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      showCell(e.currentTarget, cell);
                    } else if (e.key === 'Escape') {
                      setTooltip(null);
                    }
                  }}
                />
              );
            })}
          </div>
        ))}

        {/* Tooltip */}
        {tooltip && (
          <div
            style={{
              position: 'fixed',
              left: tooltip.x,
              top: tooltip.y,
              transform: 'translate(-50%, -100%)',
              background: 'rgba(0,0,0,0.9)',
              border: '1px solid rgba(0,212,255,0.3)',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: '0.65rem',
              color: '#fff',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
              zIndex: 100,
            }}
          >
            {tooltip.text}
          </div>
        )}
      </div>

      {/* Legend */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}
      >
        <span style={{ fontSize: '0.55rem', color: '#6a7a8a', marginRight: '4px' }}>Less</span>
        {colors.map((c, i) => (
          <div
            key={i}
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              background: c,
              border: '1px solid rgba(255,255,255,0.06)',
            }}
          />
        ))}
        <span style={{ fontSize: '0.55rem', color: '#6a7a8a', marginLeft: '4px' }}>More</span>
      </div>
    </div>
  );
}
