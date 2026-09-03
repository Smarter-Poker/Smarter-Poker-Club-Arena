import React from 'react';
import './Tag.css';

interface TagProps {
  label: string;
  onRemove?: () => void;
  color?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  size?: 'small' | 'medium';
}

export const Tag: React.FC<TagProps> = ({
  label,
  onRemove,
  color = 'default',
  size = 'medium',
}) => {
  return (
    <span className={`tag color-${color} size-${size}`}>
      {label}
      {onRemove && (
        <button className="tag-remove" onClick={onRemove}>
          ×
        </button>
      )}
    </span>
  );
};

export default Tag;
