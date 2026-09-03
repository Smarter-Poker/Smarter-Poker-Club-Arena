import React from 'react';
import './ColorPicker.css';

interface ColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  presetColors?: string[];
}

const DEFAULT_COLORS = [
  '#ffd700',
  '#ff8c00',
  '#ef4444',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f59e0b',
  '#6366f1',
];

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value,
  onChange,
  presetColors = DEFAULT_COLORS,
}) => {
  return (
    <div className="color-picker">
      <div className="color-presets">
        {presetColors.map((color) => (
          <button
            key={color}
            className={`color-swatch ${value === color ? 'selected' : ''}`}
            style={{ backgroundColor: color }}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
      <div className="color-custom">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#000000"
        />
      </div>
    </div>
  );
};

export default ColorPicker;
