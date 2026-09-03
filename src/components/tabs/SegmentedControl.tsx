import React from 'react';
import './SegmentedControl.css';

interface Segment {
  id: string;
  label: string;
}

interface SegmentedControlProps {
  segments: Segment[];
  value: string;
  onChange: (value: string) => void;
  size?: 'small' | 'medium';
}

export const SegmentedControl: React.FC<SegmentedControlProps> = ({
  segments,
  value,
  onChange,
  size = 'medium',
}) => {
  return (
    <div className={`segmented-control size-${size}`}>
      {segments.map((segment) => (
        <button
          key={segment.id}
          className={`segment ${value === segment.id ? 'active' : ''}`}
          onClick={() => onChange(segment.id)}
        >
          {segment.label}
        </button>
      ))}
    </div>
  );
};

export default SegmentedControl;
