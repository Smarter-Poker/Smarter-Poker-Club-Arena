import React, { useState, useEffect, useRef } from 'react';
import './MultiTableView.css';

interface TableInfo {
  id: string;
  name: string;
  stakes: string;
  players: number;
  maxPlayers: number;
  pot: number;
  yourStack: number;
  isYourTurn: boolean;
  timeRemaining?: number;
}

interface MultiTableViewProps {
  tables: TableInfo[];
  activeTableId: string;
  onSelectTable?: (tableId: string) => void;
  onCloseTable?: (tableId: string) => void;
}

export const MultiTableView: React.FC<MultiTableViewProps> = ({
  tables,
  activeTableId,
  onSelectTable,
  onCloseTable,
}) => {
  const [layout, setLayout] = useState<'2x2' | '3x2' | '1x1'>('2x2');
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
    staggerTimersRef.current = tables.map((_, i) =>
      setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
    );
  }, [tables]);

  const getGridClass = () => {
    switch (layout) {
      case '1x1':
        return 'grid-1x1';
      case '2x2':
        return 'grid-2x2';
      case '3x2':
        return 'grid-3x2';
    }
  };

  return (
    <div className="multi-table-view">
      <div className="multi-table-header">
        <h2>Active Tables ({tables.length})</h2>
        <div className="layout-controls">
          <button
            className={layout === '1x1' ? 'active' : ''}
            onClick={() => setLayout('1x1')}
            title="Single view"
          >
            ◼
          </button>
          <button
            className={layout === '2x2' ? 'active' : ''}
            onClick={() => setLayout('2x2')}
            title="2x2 grid"
          >
            ◫
          </button>
          <button
            className={layout === '3x2' ? 'active' : ''}
            onClick={() => setLayout('3x2')}
            title="3x2 grid"
          >
            ⊞
          </button>
        </div>
      </div>

      <div className={`tables-grid ${getGridClass()}`}>
        {tables.map((table, i) => (
          <div
            key={table.id}
            className={`table-tile ${activeTableId === table.id ? 'active' : ''} ${table.isYourTurn ? 'your-turn' : ''}`}
            onClick={() => onSelectTable?.(table.id)}
            style={{
              opacity: visibleItems.has(i) ? 1 : 0,
              transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <div className="tile-header">
              <span className="table-name">{table.name}</span>
              <button
                className="close-table"
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTable?.(table.id);
                }}
              >
                ×
              </button>
            </div>

            <div className="tile-table-visual">
              <div className="mini-table-shape">
                <span className="pot-display">{table.pot.toLocaleString()}</span>
              </div>
            </div>

            <div className="tile-info">
              <span className="stakes">{table.stakes}</span>
              <span className="players">
                {table.players}/{table.maxPlayers}
              </span>
            </div>

            <div className="tile-stack">
              <span className="stack-label">Your Stack</span>
              <span className="stack-value">{table.yourStack.toLocaleString()}</span>
            </div>

            {table.isYourTurn && (
              <div className="turn-indicator">
                <span>YOUR TURN</span>
                {table.timeRemaining && <span className="time">{table.timeRemaining}s</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default MultiTableView;
