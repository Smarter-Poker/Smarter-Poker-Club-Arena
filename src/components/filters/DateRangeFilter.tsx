import React from 'react';
import './DateRangeFilter.css';

interface DateRangeFilterProps {
  startDate: string;
  endDate: string;
  onStartChange: (date: string) => void;
  onEndChange: (date: string) => void;
  presets?: { label: string; days: number }[];
  onPresetClick?: (days: number) => void;
}

export const DateRangeFilter: React.FC<DateRangeFilterProps> = ({
  startDate,
  endDate,
  onStartChange,
  onEndChange,
  presets = [
    { label: '7D', days: 7 },
    { label: '30D', days: 30 },
    { label: '90D', days: 90 },
  ],
  onPresetClick,
}) => {
  return (
    <div className="date-range-filter">
      <div className="date-inputs">
        <input type="date" value={startDate} onChange={(e) => onStartChange(e.target.value)} />
        <span className="date-separator">To</span>
        <input type="date" value={endDate} onChange={(e) => onEndChange(e.target.value)} />
      </div>
      {onPresetClick && presets.length > 0 && (
        <div className="date-presets">
          {presets.map((p) => (
            <button key={p.days} onClick={() => onPresetClick(p.days)}>
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default DateRangeFilter;
