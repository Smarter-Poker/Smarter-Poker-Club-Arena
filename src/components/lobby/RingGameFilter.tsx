/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🎮 RING GAME FILTER — Stakes/Variant Filter Component
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * PokerBros-style filter bar for cash games:
 * - Game variant selection (NLH, PLO, etc.)
 * - Stakes range filter
 * - Table size filter
 * - Show/hide empty tables
 */

import React, { useState, useCallback, useMemo } from 'react';
import './RingGameFilter.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type GameVariant = 'ALL' | 'NLH' | 'PLO4' | 'PLO5' | 'PLO6' | 'PLO8' | 'OFC';
export type TableSize = 'ALL' | '2MAX' | '6MAX' | '9MAX';
export type StakesRange = 'ALL' | 'MICRO' | 'LOW' | 'MID' | 'HIGH';

export interface RingGameFilterState {
    variant: GameVariant;
    tableSize: TableSize;
    stakes: StakesRange;
    hideEmpty: boolean;
    hideFull: boolean;
    search: string;
}

export interface RingGameFilterProps {
    onFilterChange: (filters: RingGameFilterState) => void;
    initialFilters?: Partial<RingGameFilterState>;
    availableVariants?: GameVariant[];
    isCompact?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const VARIANT_LABELS: Record<GameVariant, string> = {
    ALL: 'All Games',
    NLH: "Hold'em",
    PLO4: 'PLO 4',
    PLO5: 'PLO 5',
    PLO6: 'PLO 6',
    PLO8: 'PLO Hi/Lo',
    OFC: 'OFC',
};

const TABLE_SIZE_LABELS: Record<TableSize, string> = {
    ALL: 'All',
    '2MAX': 'Heads-Up',
    '6MAX': '6-Max',
    '9MAX': 'Full Ring',
};

const STAKES_LABELS: Record<StakesRange, string> = {
    ALL: 'All Stakes',
    MICRO: 'Micro ($0.01-$0.10)',
    LOW: 'Low ($0.25-$1)',
    MID: 'Mid ($2-$10)',
    HIGH: 'High ($25+)',
};

const DEFAULT_FILTERS: RingGameFilterState = {
    variant: 'ALL',
    tableSize: 'ALL',
    stakes: 'ALL',
    hideEmpty: false,
    hideFull: false,
    search: '',
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function RingGameFilter({
    onFilterChange,
    initialFilters,
    availableVariants = ['ALL', 'NLH', 'PLO4', 'PLO5', 'PLO6'],
    isCompact = false,
}: RingGameFilterProps) {
    const [filters, setFilters] = useState<RingGameFilterState>({
        ...DEFAULT_FILTERS,
        ...initialFilters,
    });

    const [isExpanded, setIsExpanded] = useState(false);

    // Update a single filter
    const updateFilter = useCallback(
        <K extends keyof RingGameFilterState>(key: K, value: RingGameFilterState[K]) => {
            const newFilters = { ...filters, [key]: value };
            setFilters(newFilters);
            onFilterChange(newFilters);
        },
        [filters, onFilterChange]
    );

    // Reset all filters
    const resetFilters = useCallback(() => {
        setFilters(DEFAULT_FILTERS);
        onFilterChange(DEFAULT_FILTERS);
    }, [onFilterChange]);

    // Count active filters
    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (filters.variant !== 'ALL') count++;
        if (filters.tableSize !== 'ALL') count++;
        if (filters.stakes !== 'ALL') count++;
        if (filters.hideEmpty) count++;
        if (filters.hideFull) count++;
        if (filters.search) count++;
        return count;
    }, [filters]);

    return (
        <div className={`ring-filter ${isCompact ? 'ring-filter--compact' : ''}`}>
            {/* Main Filter Bar */}
            <div className="ring-filter__bar">
                {/* Search Input */}
                <div className="ring-filter__search">
                    <span className="ring-filter__search-icon">🔍</span>
                    <input
                        type="text"
                        className="ring-filter__search-input"
                        placeholder="Search tables..."
                        value={filters.search}
                        onChange={(e) => updateFilter('search', e.target.value)}
                    />
                    {filters.search && (
                        <button
                            className="ring-filter__search-clear"
                            onClick={() => updateFilter('search', '')}
                        >
                            ×
                        </button>
                    )}
                </div>

                {/* Variant Pills */}
                <div className="ring-filter__pills">
                    {availableVariants.map((variant) => (
                        <button
                            key={variant}
                            className={`ring-filter__pill ${filters.variant === variant ? 'ring-filter__pill--active' : ''}`}
                            onClick={() => updateFilter('variant', variant)}
                        >
                            {VARIANT_LABELS[variant]}
                        </button>
                    ))}
                </div>

                {/* Filter Toggle */}
                <button
                    className={`ring-filter__toggle ${activeFilterCount > 0 ? 'ring-filter__toggle--active' : ''}`}
                    onClick={() => setIsExpanded(!isExpanded)}
                >
                    <span>Filters</span>
                    {activeFilterCount > 0 && (
                        <span className="ring-filter__badge">{activeFilterCount}</span>
                    )}
                    <span className={`ring-filter__arrow ${isExpanded ? 'ring-filter__arrow--up' : ''}`}>
                        ▼
                    </span>
                </button>
            </div>

            {/* Expanded Filters */}
            {isExpanded && (
                <div className="ring-filter__expanded">
                    {/* Table Size */}
                    <div className="ring-filter__group">
                        <span className="ring-filter__group-label">Table Size</span>
                        <div className="ring-filter__options">
                            {(['ALL', '2MAX', '6MAX', '9MAX'] as TableSize[]).map((size) => (
                                <button
                                    key={size}
                                    className={`ring-filter__option ${filters.tableSize === size ? 'ring-filter__option--active' : ''}`}
                                    onClick={() => updateFilter('tableSize', size)}
                                >
                                    {TABLE_SIZE_LABELS[size]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Stakes Range */}
                    <div className="ring-filter__group">
                        <span className="ring-filter__group-label">Stakes</span>
                        <div className="ring-filter__options">
                            {(['ALL', 'MICRO', 'LOW', 'MID', 'HIGH'] as StakesRange[]).map((stakes) => (
                                <button
                                    key={stakes}
                                    className={`ring-filter__option ${filters.stakes === stakes ? 'ring-filter__option--active' : ''}`}
                                    onClick={() => updateFilter('stakes', stakes)}
                                >
                                    {STAKES_LABELS[stakes].split(' ')[0]}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Toggles */}
                    <div className="ring-filter__toggles">
                        <label className="ring-filter__checkbox">
                            <input
                                type="checkbox"
                                checked={filters.hideEmpty}
                                onChange={(e) => updateFilter('hideEmpty', e.target.checked)}
                            />
                            <span className="ring-filter__checkmark" />
                            <span>Hide Empty</span>
                        </label>

                        <label className="ring-filter__checkbox">
                            <input
                                type="checkbox"
                                checked={filters.hideFull}
                                onChange={(e) => updateFilter('hideFull', e.target.checked)}
                            />
                            <span className="ring-filter__checkmark" />
                            <span>Hide Full</span>
                        </label>

                        {/* Reset Button */}
                        {activeFilterCount > 0 && (
                            <button className="ring-filter__reset" onClick={resetFilters}>
                                Reset All
                            </button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default RingGameFilter;
