/**
 * ♠ CLUB ARENA — Multi-Table Manager
 * Support for up to 4 concurrent tables with tiled view
 */

import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import './MultiTableManager.css';

export interface ActiveTable {
  id: string;
  name: string;
  stakes: string;
  pot: number;
  isMyTurn: boolean;
  timeRemaining?: number;
}

interface MultiTableManagerProps {
  tables: ActiveTable[];
  activeTableId: string;
  onTableSelect: (tableId: string) => void;
  onTableClose: (tableId: string) => void;
  viewMode: 'single' | 'tiled';
  onViewModeChange: (mode: 'single' | 'tiled') => void;
}

export const MultiTableManager: React.FC<MultiTableManagerProps> = ({
  tables,
  activeTableId,
  onTableSelect,
  onTableClose,
  viewMode,
  onViewModeChange,
}) => {
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

  return (
    <div className="multi-table-manager">
      {/* View mode toggle */}
      <div className="view-toggle">
        <button
          className={viewMode === 'single' ? 'active' : ''}
          onClick={() => onViewModeChange('single')}
        >
          ▢ Single
        </button>
        <button
          className={viewMode === 'tiled' ? 'active' : ''}
          onClick={() => onViewModeChange('tiled')}
          disabled={tables.length < 2}
        >
          ⊞ Tiled
        </button>
      </div>

      {/* Table tabs */}
      <div className="table-tabs">
        {tables.map((table, idx) => (
          <div
            key={table.id}
            className={`table-tab ${table.id === activeTableId ? 'active' : ''} ${table.isMyTurn ? 'my-turn' : ''}`}
            onClick={() => onTableSelect(table.id)}
            style={{
              opacity: visibleItems.has(idx) ? 1 : 0,
              transform: visibleItems.has(idx) ? 'translateY(0)' : 'translateY(8px)',
              transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
            }}
          >
            <span className="table-num">{idx + 1}</span>
            <div className="table-info">
              <span className="table-name">{table.name}</span>
              <span className="table-stakes">{table.stakes}</span>
            </div>
            {table.isMyTurn && (
              <span className="turn-indicator">
                {table.timeRemaining && table.timeRemaining < 10 ? `${table.timeRemaining}s` : '●'}
              </span>
            )}
            <button
              className="close-tab"
              onClick={(e) => {
                e.stopPropagation();
                onTableClose(table.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}

        {tables.length < 4 && <button className="add-table-tab">+ Add Table</button>}
      </div>
    </div>
  );
};

// Hook for multi-table state management
export const useMultiTable = () => {
  const [tables, setTables] = useState<ActiveTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string>('');
  const [viewMode, setViewMode] = useState<'single' | 'tiled'>('single');

  const addTable = (table: ActiveTable) => {
    if (tables.length >= 4) {
      console.warn('[MultiTable] Maximum 4 tables allowed');
      return false;
    }
    setTables((prev) => [...prev, table]);
    setActiveTableId(table.id);
    return true;
  };

  const removeTable = (tableId: string) => {
    setTables((prev) => prev.filter((t) => t.id !== tableId));
    if (activeTableId === tableId && tables.length > 1) {
      const remaining = tables.filter((t) => t.id !== tableId);
      setActiveTableId(remaining[0]?.id || '');
    }
  };

  const updateTable = (tableId: string, updates: Partial<ActiveTable>) => {
    setTables((prev) => prev.map((t) => (t.id === tableId ? { ...t, ...updates } : t)));
  };

  // Auto-switch to table when it's my turn
  useEffect(() => {
    const urgentTable = tables.find((t) => t.isMyTurn && t.timeRemaining && t.timeRemaining < 5);
    if (urgentTable && urgentTable.id !== activeTableId) {
      setActiveTableId(urgentTable.id);
    }
  }, [tables, activeTableId]);

  return {
    tables,
    activeTableId,
    viewMode,
    setActiveTableId,
    setViewMode,
    addTable,
    removeTable,
    updateTable,
  };
};

export default MultiTableManager;
