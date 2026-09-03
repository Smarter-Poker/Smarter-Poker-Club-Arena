import React from 'react';
import './SearchFilters.css';

interface Filter {
  id: string;
  label: string;
  count?: number;
}

interface SearchFiltersProps {
  filters: Filter[];
  activeFilters: string[];
  onFilterToggle: (filterId: string) => void;
  onClearAll?: () => void;
}

export const SearchFilters: React.FC<SearchFiltersProps> = ({
  filters,
  activeFilters,
  onFilterToggle,
  onClearAll,
}) => {
  return (
    <div className="search-filters">
      {activeFilters.length > 0 && (
        <button className="clear-filters" onClick={onClearAll}>
          Clear All
        </button>
      )}
      <div className="filter-chips">
        {filters.map((filter) => (
          <button
            key={filter.id}
            className={`filter-chip ${activeFilters.includes(filter.id) ? 'active' : ''}`}
            onClick={() => onFilterToggle(filter.id)}
          >
            {filter.label}
            {filter.count !== undefined && <span className="chip-count">{filter.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SearchFilters;
