import React from 'react';
import './SearchResults.css';

interface ResultItem {
  id: string;
  type: 'player' | 'club' | 'table' | 'tournament';
  title: string;
  subtitle?: string;
  imageUrl?: string;
  metadata?: Record<string, string>;
}

interface SearchResultsProps {
  results: ResultItem[];
  isLoading?: boolean;
  query?: string;
  onResultClick?: (id: string, type: string) => void;
}

const TYPE_ICONS = {
  player: '●',
  club: '■',
  table: '▦',
  tournament: '♛',
};

export const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  isLoading = false,
  query = '',
  onResultClick,
}) => {
  if (isLoading) {
    return (
      <div className="search-results loading">
        <div className="loading-spinner" />
        <p>Searching...</p>
      </div>
    );
  }

  if (results.length === 0 && query) {
    return (
      <div className="search-results empty">
        <span className="empty-icon">◌</span>
        <p>No Results Found For "{query}"</p>
      </div>
    );
  }

  return (
    <div className="search-results">
      {results.map((result) => (
        <div
          key={result.id}
          className={`result-item type-${result.type}`}
          onClick={() => onResultClick?.(result.id, result.type)}
        >
          <div className="result-image">
            {result.imageUrl ? (
              <img loading="lazy" decoding="async" src={result.imageUrl} alt="" />
            ) : (
              <span>{TYPE_ICONS[result.type]}</span>
            )}
          </div>
          <div className="result-info">
            <div className="result-title">{result.title}</div>
            {result.subtitle && <div className="result-subtitle">{result.subtitle}</div>}
          </div>
          <span className="result-type">{result.type}</span>
        </div>
      ))}
    </div>
  );
};

export default SearchResults;
