import React from 'react';
import './FilterChips.css';

interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

interface FilterChipsProps {
  options: FilterOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  multiple?: boolean;
}

export const FilterChips: React.FC<FilterChipsProps> = ({
  options,
  selected,
  onChange,
  multiple = true,
}) => {
  const toggle = (value: string) => {
    if (multiple) {
      onChange(
        selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]
      );
    } else {
      onChange(selected.includes(value) ? [] : [value]);
    }
  };

  return (
    <div className="filter-chips">
      {options.map((opt) => (
        <button
          key={opt.value}
          className={`filter-chip ${selected.includes(opt.value) ? 'selected' : ''}`}
          onClick={() => toggle(opt.value)}
        >
          {opt.label}
          {opt.count !== undefined && <span className="chip-count">{opt.count}</span>}
        </button>
      ))}
    </div>
  );
};

export default FilterChips;
