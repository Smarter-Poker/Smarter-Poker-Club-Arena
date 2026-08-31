/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SEARCH — Search Components
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import './Search.css';

interface SearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  loading?: boolean;
  onClear?: () => void;
  onSubmit?: (value: string) => void;
  size?: 'small' | 'medium' | 'large';
  fullWidth?: boolean;
  className?: string;
}

/**
 * Search input component
 */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  autoFocus = false,
  loading = false,
  onClear,
  onSubmit,
  size = 'medium',
  fullWidth = false,
  className = '',
}: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClear = () => {
    onChange('');
    onClear?.();
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && onSubmit) {
      onSubmit(value);
    }
    if (e.key === 'Escape') {
      handleClear();
    }
  };

  return (
    <div className={`search-input search-${size} ${fullWidth ? 'search-full' : ''} ${className}`}>
      <span className="search-icon">⌕</span>
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="search-field"
      />
      <AnimatePresence>
        {loading && (
          <motion.span
            className="search-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            ⟳
          </motion.span>
        )}
        {!loading && value && (
          <motion.button
            className="search-clear"
            onClick={handleClear}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            aria-label="Clear Search"
          >
            ✕
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Search with dropdown results
 */
export function SearchWithResults<T>({
  value,
  onChange,
  results,
  onSelect,
  renderResult,
  loading = false,
  placeholder = 'Search...',
  emptyMessage = 'No results found',
  className = '',
}: {
  value: string;
  onChange: (value: string) => void;
  results: T[];
  onSelect: (item: T) => void;
  renderResult: (item: T, index: number) => React.ReactNode;
  loading?: boolean;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setIsOpen(value.length > 0);
    setHighlightedIndex(0);
  }, [value, results]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setHighlightedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setHighlightedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          if (results[highlightedIndex]) {
            onSelect(results[highlightedIndex]);
            setIsOpen(false);
          }
          break;
        case 'Escape':
          setIsOpen(false);
          break;
      }
    },
    [isOpen, results, highlightedIndex, onSelect]
  );

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div ref={containerRef} className={`search-with-results ${className}`}>
      <SearchInput value={value} onChange={onChange} placeholder={placeholder} loading={loading} />
      <div onKeyDown={handleKeyDown} tabIndex={-1}>
        <AnimatePresence>
          {isOpen && (
            <motion.div
              className="search-results"
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
            >
              {loading ? (
                <div className="search-results-loading">Searching...</div>
              ) : results.length === 0 ? (
                <div className="search-results-empty">{emptyMessage}</div>
              ) : (
                results.map((item, index) => (
                  <motion.div
                    key={index}
                    className={`search-result-item ${index === highlightedIndex ? 'highlighted' : ''}`}
                    onClick={() => {
                      onSelect(item);
                      setIsOpen(false);
                    }}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: index * 0.04, duration: 0.25 }}
                  >
                    {renderResult(item, index)}
                  </motion.div>
                ))
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Filter chips for filtering search results
 */
export function FilterChips({
  filters,
  selected,
  onChange,
  multiple = false,
}: {
  filters: Array<{ id: string; label: string; count?: number }>;
  selected: string[];
  onChange: (selected: string[]) => void;
  multiple?: boolean;
}) {
  const handleClick = (id: string) => {
    if (multiple) {
      if (selected.includes(id)) {
        onChange(selected.filter((s) => s !== id));
      } else {
        onChange([...selected, id]);
      }
    } else {
      onChange(selected.includes(id) ? [] : [id]);
    }
  };

  return (
    <div className="filter-chips">
      {filters.map(({ id, label, count }) => (
        <button
          key={id}
          className={`filter-chip ${selected.includes(id) ? 'active' : ''}`}
          onClick={() => handleClick(id)}
        >
          {label}
          {count !== undefined && <span className="filter-chip-count">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export default SearchInput;
