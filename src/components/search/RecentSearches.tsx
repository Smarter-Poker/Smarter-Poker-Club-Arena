import React from 'react';
import './RecentSearches.css';

interface RecentSearch {
  id: string;
  query: string;
  timestamp: Date;
  type?: 'player' | 'club' | 'table' | 'tournament';
}

interface RecentSearchesProps {
  searches: RecentSearch[];
  onSearchClick?: (query: string) => void;
  onRemove?: (id: string) => void;
  onClearAll?: () => void;
}

export const RecentSearches: React.FC<RecentSearchesProps> = ({
  searches,
  onSearchClick,
  onRemove,
  onClearAll,
}) => {
  if (searches.length === 0) return null;

  return (
    <div className="recent-searches">
      <div className="recent-header">
        <h4>Recent Searches</h4>
        <button className="clear-all" onClick={onClearAll}>
          Clear
        </button>
      </div>
      <div className="recent-list">
        {searches.map((search) => (
          <div
            key={search.id}
            className="recent-item"
            onClick={() => onSearchClick?.(search.query)}
          >
            <span className="recent-icon">◷</span>
            <span className="recent-query">{search.query}</span>
            {search.type && <span className="recent-type">{search.type}</span>}
            <button
              className="remove-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRemove?.(search.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RecentSearches;
